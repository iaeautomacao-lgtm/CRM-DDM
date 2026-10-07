import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; contact_id: string | null; scheduled_at: string | null }>,
  rpc: vi.fn(),
  drain: vi.fn(async () => ({ ok: true, moved: 0, partial: false })),
  updates: [] as Array<{ value: Record<string, unknown>; filters: Array<[string, unknown]> }>,
}));
vi.mock("@/lib/disparador/queue-moves", () => ({ drainDispatchMoves: mocks.drain }));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: () => {
      const filters: Array<[string, unknown]> = [];
      let update: Record<string, unknown> | null = null;
      let range: [number, number] = [0, Number.MAX_SAFE_INTEGER];
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.order = () => builder;
      builder.eq = (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      };
      builder.range = (from: number, to: number) => {
        range = [from, to];
        return builder;
      };
      builder.update = (value: Record<string, unknown>) => {
        update = value;
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) => {
        if (update) {
          mocks.updates.push({ value: update, filters });
          return Promise.resolve({ error: null }).then(resolve);
        }
        return Promise.resolve({ data: mocks.rows.slice(range[0], range[1] + 1), error: null }).then(resolve);
      };
      return builder;
    },
  }),
}));

import {
  needsQueueReflow,
  planQueueReflow,
  reflowCampaignQueue,
  resumeBatchedCampaign,
  REFLOW_CHUNK_SIZE,
  type ReflowSourceItem,
} from "./queue-reflow";
import { isScheduledInClosedWindow } from "./window-clock";

// Horário de Brasília → instante UTC. Outubro/2026: 16 = sexta,
// 17 = sábado, 18 = domingo, 19 = segunda, 20 = terça, 27 = terça seguinte.
const br = (day: number, hh: number, mm = 0, ss = 0) => new Date(Date.UTC(2026, 9, day, hh + 3, mm, ss));
const MIN = 60_000;
const diasUteis = { inicio: "08:00", fim: "18:00", dias: [1, 2, 3, 4, 5] };

/** Fila antiga: rodadas de `batch` contatos a cada 30 min no relógio comum. */
function legacyQueue(from: Date, rounds: number, batch: number): ReflowSourceItem[] {
  const items: ReflowSourceItem[] = [];
  for (let k = 0; k < rounds; k++) {
    for (let p = 0; p < batch; p++) {
      const n = k * batch + p;
      items.push({
        id: `item-${String(n).padStart(5, "0")}`,
        contact_id: `contact-${n}`,
        scheduled_at: new Date(from.getTime() + k * 30 * MIN + p * 100).toISOString(),
      });
    }
  }
  return items;
}

describe("needsQueueReflow", () => {
  it("fila antiga com rodadas no fim de semana: precisa", () => {
    const due = legacyQueue(br(16, 18, 30), 4, 2);
    expect(needsQueueReflow(due, diasUteis, 2)).toBe(true);
  });

  it("fila já consistente (horário aberto + transbordo da rodada das 17:59) não é tocada", () => {
    const due = [
      { scheduled_at: br(19, 9).toISOString() },
      { scheduled_at: br(16, 17, 59).toISOString() },
      { scheduled_at: br(16, 18, 1, 10).toISOString() },
    ];
    expect(needsQueueReflow(due, diasUteis, 700)).toBe(false);
  });

  it("modo sequencial (batch_size 1) nunca é redistribuído", () => {
    expect(needsQueueReflow([{ scheduled_at: br(17, 10).toISOString() }], diasUteis, 1)).toBe(false);
  });

  it("retry avulso à noite não redistribui a campanha", () => {
    expect(needsQueueReflow([{ scheduled_at: br(16, 22).toISOString(), tentativas: 2 }], diasUteis, 50)).toBe(false);
  });
});

describe("planQueueReflow", () => {
  it("fila do fim de semana (sex 18:30 → seg): ordem mantida e pausa medida em tempo aberto", () => {
    // Rodadas a cada 30 min a partir de sexta 18:30 (relógio comum).
    const items = legacyQueue(br(16, 18, 30), 117, 3);
    const plan = planQueueReflow(items, { start: br(19, 8), batchSize: 3, pauseSeconds: 1800, janela: diasUteis });

    expect(plan.map((a) => a.id)).toEqual(items.map((i) => i.id));
    const times = plan.map((a) => new Date(a.scheduled_at).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    // Toda a fila em tempo aberto: o detector não dispara de novo.
    expect(needsQueueReflow(plan, diasUteis, 3)).toBe(false);
    for (const a of plan) expect(isScheduledInClosedWindow(new Date(a.scheduled_at), diasUteis, 0)).toBe(false);
    // Rodadas: seg 08:00, 08:30, 09:00… (20 por dia de 10h). 117 rodadas =
    // 5 dias úteis cheios (100) + 17 → a última é segunda 26/10 16:00: só o
    // necessário para o número real de rodadas, pulando o fim de semana.
    expect(plan[0].scheduled_at).toBe(br(19, 8).toISOString());
    expect(plan[3].scheduled_at).toBe(br(19, 8, 30).toISOString());
    expect(plan[1].scheduled_at).toBe(new Date(br(19, 8).getTime() + 100).toISOString());
    expect(plan[20 * 3].scheduled_at).toBe(br(20, 8).toISOString());
    expect(plan[plan.length - 3].scheduled_at).toBe(br(26, 16).toISOString());
  });

  it("segunda 07:45 x 08:00: a ordem é preservada (antes a de 07:45 ia para 27/10)", () => {
    const items: ReflowSourceItem[] = [
      { id: "b", contact_id: "c2", scheduled_at: br(19, 8).toISOString() },
      { id: "a", contact_id: "c1", scheduled_at: br(19, 7, 45).toISOString() },
    ].sort((x, y) => x.scheduled_at.localeCompare(y.scheduled_at));
    const plan = planQueueReflow(items, { start: br(19, 8), batchSize: 1, pauseSeconds: 1800, janela: diasUteis });
    expect(plan).toEqual([
      { id: "a", scheduled_at: br(19, 8).toISOString() },
      { id: "b", scheduled_at: br(19, 8, 30).toISOString() },
    ]);
    expect(new Date(plan[0].scheduled_at).getTime()).toBeLessThan(br(27, 0).getTime());
  });

  it("sequência do mesmo contato fica junta, em ordem, a 7 s; contatos externos são unidades sozinhas", () => {
    const at = (mm: number, ss = 0) => br(16, 19, mm, ss).toISOString();
    const items: ReflowSourceItem[] = [
      { id: "a1", contact_id: "A", scheduled_at: at(0) },
      { id: "b1", contact_id: "B", scheduled_at: at(0, 1) },
      { id: "a2", contact_id: "A", scheduled_at: at(0, 3) },
      { id: "b2", contact_id: "B", scheduled_at: at(0, 4) },
      { id: "x", contact_id: null, scheduled_at: at(30) },
      { id: "y", contact_id: null, scheduled_at: at(30, 1) },
    ];
    const plan = planQueueReflow(items, { start: br(19, 8), batchSize: 2, pauseSeconds: 600, janela: diasUteis });
    const t = (ms: number) => new Date(br(19, 8).getTime() + ms).toISOString();
    expect(plan).toEqual([
      { id: "a1", scheduled_at: t(0) },
      { id: "a2", scheduled_at: t(7000) },
      { id: "b1", scheduled_at: t(100) },
      { id: "b2", scheduled_at: t(7100) },
      { id: "x", scheduled_at: t(10 * MIN) },
      { id: "y", scheduled_at: t(10 * MIN + 100) },
    ]);
  });

  it("rodada grande (Imediato 50 mil): a rodada inteira vence em < 2 s, ordem mantida, sequência a 7 s", () => {
    // Fila antiga de 50 mil contatos × 2 mensagens com o espalhamento antigo
    // (100 ms × posição: a última só vencia ~83 min depois do início).
    const from = br(16, 19);
    const items: ReflowSourceItem[] = [];
    for (let n = 0; n < 50_000; n++) {
      const at = from.getTime() + n * 100;
      items.push({ id: `m1-${n}`, contact_id: `c-${n}`, scheduled_at: new Date(at).toISOString() });
      items.push({ id: `m2-${n}`, contact_id: `c-${n}`, scheduled_at: new Date(at + 3000).toISOString() });
    }
    items.sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") || a.id.localeCompare(b.id));
    const start = br(19, 8);
    const plan = planQueueReflow(items, { start, batchSize: 999_999, pauseSeconds: 0, janela: diasUteis });
    expect(plan).toHaveLength(100_000);
    const at = new Map(plan.map((a) => [a.id, new Date(a.scheduled_at).getTime()]));
    let firstMax = 0;
    let secondMin = Number.POSITIVE_INFINITY;
    let prev = 0;
    let outOfOrder = 0;
    let badGap = 0;
    for (let n = 0; n < 50_000; n++) {
      const m1 = at.get(`m1-${n}`)!;
      const m2 = at.get(`m2-${n}`)!;
      if (m1 < prev) outOfOrder++; // FIFO entre contatos
      prev = m1;
      if (m2 - m1 !== 7000) badGap++;
      firstMax = Math.max(firstMax, m1);
      secondMin = Math.min(secondMin, m2);
    }
    expect(outOfOrder).toBe(0);
    expect(badGap).toBe(0);
    expect(at.get("m1-0")).toBe(start.getTime());
    expect(firstMax - start.getTime()).toBeLessThan(2000);
    expect(firstMax).toBeLessThan(secondMin);
  }, 30_000);
});

describe("reflowCampaignQueue (gravação)", () => {
  const campaign = {
    id: "camp",
    janela_inicio: "08:00",
    janela_fim: "18:00",
    dias_envio: [1, 2, 3, 4, 5],
    batch_size: 2,
    batch_pause_seconds: 1800,
  };
  beforeEach(() => {
    mocks.rows = legacyQueue(br(16, 18, 30), 600, 2); // 1200 itens → 2 páginas, 3 pedaços
    mocks.updates.length = 0;
    mocks.rpc.mockReset();
  });

  it("via RPC: pedaços de 500, do fim para o começo", async () => {
    mocks.rpc.mockImplementation(async (_name: string, args: { p_items: unknown[] }) => ({
      data: args.p_items.length,
      error: null,
    }));
    const res = await reflowCampaignQueue(campaign, br(19, 8));
    expect(res).toEqual({ ok: true, items: 1200, updated: 1200, via: "rpc" });
    const calls = mocks.rpc.mock.calls as Array<[string, { p_campaign_id: string; p_items: Array<{ id: string }> }]>;
    expect(calls.map(([name]) => name)).toEqual(Array(3).fill("reflow_campaign_queue"));
    expect(calls.map(([, a]) => a.p_items.length)).toEqual([200, REFLOW_CHUNK_SIZE, REFLOW_CHUNK_SIZE]);
    expect(calls[0][1].p_items[0].id).toBe("item-01000");
    expect(calls[2][1].p_items[0].id).toBe("item-00000");
    expect(calls.every(([, a]) => a.p_campaign_id === "camp")).toBe(true);
  });

  it("sem a migration 163: fallback item a item só altera itens ainda 'agendado'", async () => {
    mocks.rows = mocks.rows.slice(0, 10);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    const res = await reflowCampaignQueue(campaign, br(19, 8));
    expect(res).toEqual({ ok: true, items: 10, updated: 10, via: "fallback" });
    expect(mocks.updates).toHaveLength(10);
    for (const u of mocks.updates) {
      expect(Object.keys(u.value)).toEqual(["scheduled_at"]);
      expect(u.filters).toContainEqual(["status", "agendado"]);
      expect(u.filters).toContainEqual(["campaign_id", "camp"]);
    }
  });

  it("o reflow do cron só mexe em itens 'agendado'", async () => {
    mocks.rows = mocks.rows.slice(0, 4);
    mocks.rpc.mockResolvedValue({ data: 4, error: null });
    await reflowCampaignQueue(campaign, br(19, 8));
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_status: "agendado" });
  });

  it("erro do banco na RPC: não grava nada item a item e devolve falha (o cron não envia neste tick)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "statement timeout" } });
    const res = await reflowCampaignQueue(campaign, br(19, 8));
    expect(res).toEqual({ ok: false, error: "statement timeout" });
    expect(mocks.updates).toHaveLength(0);
  });
});

describe("resumeBatchedCampaign (retomada de campanha em lote pausada)", () => {
  const campaign = {
    id: "camp",
    janela_inicio: "08:00",
    janela_fim: "18:00",
    dias_envio: [1, 2, 3, 4, 5],
    batch_size: 2,
    batch_pause_seconds: 1800,
  };
  type Call = [string, Record<string, unknown>];
  const calls = () => mocks.rpc.mock.calls as Call[];
  beforeEach(() => {
    // Itens pausados no ritmo original (sexta à tarde); retomada na segunda.
    mocks.rows = legacyQueue(br(16, 15), 3, 2);
    mocks.updates.length = 0;
    mocks.rpc.mockReset();
    mocks.drain.mockClear();
  });

  it("termina a movimentação em lotes da pausa antes de planejar e a da retomada depois (migration 184)", async () => {
    mocks.rpc.mockImplementation(async (name: string, args: { p_items?: unknown[] }) => ({
      data: name === "reflow_campaign_queue" ? args.p_items?.length : 6,
      error: null,
    }));
    await resumeBatchedCampaign(campaign, "acc", br(19, 10));
    expect(mocks.drain).toHaveBeenCalledTimes(2);
    expect(mocks.drain.mock.calls.every((c) => c[1] === "camp")).toBe(true);
  });

  it("grava o ritmo nos itens 'pausado' e retoma sem pôr scheduled_at = agora", async () => {
    mocks.rpc.mockImplementation(async (name: string, args: { p_items?: unknown[] }) => ({
      data: name === "reflow_campaign_queue" ? args.p_items?.length : 6,
      error: null,
    }));
    const res = await resumeBatchedCampaign(campaign, "acc", br(19, 10));
    expect(res).toEqual({ ok: true, resumed: 6 });
    expect(calls().map(([name]) => name)).toEqual(["reflow_campaign_queue", "resume_dispatch_campaign_keep_schedule"]);
    const [, reflowArgs] = calls()[0];
    expect(reflowArgs.p_status).toBe("pausado");
    const items = reflowArgs.p_items as Array<{ id: string; scheduled_at: string }>;
    // Ordem mantida; 3 rodadas de 2 a cada 30 min a partir de agora — não a
    // fila inteira vencida junto.
    expect(items.map((i) => i.id)).toEqual(mocks.rows.map((r) => r.id));
    expect(items.map((i) => i.scheduled_at)).toEqual([
      br(19, 10).toISOString(),
      new Date(br(19, 10).getTime() + 100).toISOString(),
      br(19, 10, 30).toISOString(),
      new Date(br(19, 10, 30).getTime() + 100).toISOString(),
      br(19, 11).toISOString(),
      new Date(br(19, 11).getTime() + 100).toISOString(),
    ]);
    expect(calls()[1][1]).toEqual({ p_campaign_id: "camp", p_account_id: "acc" });
  });

  it("retomada fora da janela: 1ª rodada na próxima abertura", async () => {
    mocks.rpc.mockImplementation(async (name: string, args: { p_items?: unknown[] }) => ({
      data: name === "reflow_campaign_queue" ? args.p_items?.length : 6,
      error: null,
    }));
    await resumeBatchedCampaign(campaign, "acc", br(17, 10)); // sábado
    const items = calls()[0][1].p_items as Array<{ scheduled_at: string }>;
    expect(items[0].scheduled_at).toBe(br(19, 8).toISOString());
  });

  it("falha ao gravar o ritmo: não retoma (campanha continua pausada)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    const res = await resumeBatchedCampaign(campaign, "acc", br(19, 10));
    expect(res).toMatchObject({ ok: false, reason: "error" });
    expect(calls().some(([name]) => name.startsWith("resume_dispatch_campaign"))).toBe(false);
  });

  it("estado mudou (não está mais pausada): 409", async () => {
    mocks.rpc.mockImplementation(async (name: string, args: { p_items?: unknown[] }) => ({
      data: name === "reflow_campaign_queue" ? args.p_items?.length : null,
      error: null,
    }));
    expect(await resumeBatchedCampaign(campaign, "acc", br(19, 10))).toMatchObject({ ok: false, reason: "state_changed" });
  });

  it("sem a migration 163: retoma pela RPC antiga e regrava o mesmo plano nos itens 'agendado'", async () => {
    const missing = { data: null, error: { code: "PGRST202", message: "not found" } };
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "resume_dispatch_campaign" ? { data: 6, error: null } : missing
    );
    const res = await resumeBatchedCampaign(campaign, "acc", br(19, 10));
    expect(res).toEqual({ ok: true, resumed: 6 });
    // 6 updates em 'pausado' antes, 6 em 'agendado' depois da retomada.
    const byStatus = (s: string) =>
      mocks.updates.filter((u) => u.filters.some(([c, v]) => c === "status" && v === s));
    expect(byStatus("pausado")).toHaveLength(6);
    expect(byStatus("agendado")).toHaveLength(6);
    expect(byStatus("agendado").map((u) => u.value.scheduled_at)).toEqual(
      byStatus("pausado").map((u) => u.value.scheduled_at)
    );
  });
});
