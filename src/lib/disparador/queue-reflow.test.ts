import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; contact_id: string | null; scheduled_at: string | null }>,
  rpc: vi.fn(),
  updates: [] as Array<{ value: Record<string, unknown>; filters: Array<[string, unknown]> }>,
}));
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

  it("sequência do mesmo contato fica junta, em ordem, a 3 s; contatos externos são unidades sozinhas", () => {
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
      { id: "a2", scheduled_at: t(3000) },
      { id: "b1", scheduled_at: t(100) },
      { id: "b2", scheduled_at: t(3100) },
      { id: "x", scheduled_at: t(10 * MIN) },
      { id: "y", scheduled_at: t(10 * MIN + 100) },
    ]);
  });
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

  it("erro do banco na RPC: não grava nada item a item e devolve falha (o cron não envia neste tick)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "statement timeout" } });
    const res = await reflowCampaignQueue(campaign, br(19, 8));
    expect(res).toEqual({ ok: false, error: "statement timeout" });
    expect(mocks.updates).toHaveLength(0);
  });
});
