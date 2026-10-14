import { beforeEach, describe, expect, it, vi } from "vitest";

import { aggregateStage, classifySituacao, normalizeSituacao, reportUnknownSituacao, resetUnknownSituacaoLog } from "@/lib/billing/ddm-situacao";
import { interpretSituation, type DdmSituation } from "@/lib/billing/ddm-source";
import { detectFromDdm } from "./ingest";

describe("mapeamento único de situacao_acordo", () => {
  it.each([
    ["Quitado", "paid"],
    ["quitada", "paid"],
    ["PAGO", "paid"],
    ["Liquidado", "paid"],
    ["Acordo pago", "paid"],
    ["Acordo na DDM", "agreement"],
    ["Aguardando Pgto", "agreement"],
    ["Aguardando pagamento", "agreement"],
    ["Acordo vigente", "agreement"],
    ["Acordo formalizado", "agreement"],
    ["acordo ativo", "agreement"],
    ["Em andamento", "agreement"],
    ["Formalizado", "agreement"],
    ["  ACORDO   NA  DDM ", "agreement"],
    ["Acordo não pago", "agreement"],
    ["Em aberto", "none"],
    ["Aberto", "none"],
    ["Inadimplente", "none"],
    ["Sem acordo", "none"],
    ["Nenhum", "none"],
    ["Não possui acordo", "none"],
    ["", "none"],
    [null, "none"],
    ["Cancelado pela instituição", "unknown"],
    ["status-novo-xyz", "unknown"],
    ["Não pago", "unknown"],
  ])("%j ⇒ %s", (raw, expected) => {
    expect(classifySituacao(raw)).toBe(expected);
  });

  it("normaliza acento, caixa e espaços", () => {
    expect(normalizeSituacao("  Não  Possui ACORDO ")).toBe("nao possui acordo");
  });

  it("agrega as dívidas do CPF: acordo em andamento vence; só é paid se TODAS estão pagas; desconhecido não marca", () => {
    expect(aggregateStage(["Quitado", "Acordo na DDM"])).toBe("agreement");
    expect(aggregateStage(["Quitado", "Pago"])).toBe("paid");
    expect(aggregateStage(["Quitado", "Em aberto"])).toBe("none");
    expect(aggregateStage(["Quitado", "xyz-novo"])).toBe("unknown");
    expect(aggregateStage([null, null])).toBe("none");
    expect(aggregateStage([])).toBe("paid"); // lista vazia = sem dívida ativa (premissa do dono, EMPTY_LIST_MEANS_PAID)
  });

  it("valor desconhecido é logado UMA vez (sem repetir, sem dado pessoal)", () => {
    resetUnknownSituacaoLog();
    const log = vi.fn();
    reportUnknownSituacao("Status Novo XYZ", log);
    reportUnknownSituacao("status novo xyz", log);
    reportUnknownSituacao("  STATUS   NOVO XYZ ", log);
    reportUnknownSituacao("", log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("status novo xyz");
    reportUnknownSituacao("outro valor", log);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("interpretSituation usa o mesmo mapeamento (stage, settled e valores desconhecidos)", () => {
    expect(interpretSituation([{ situacao_acordo: "Acordo na DDM", valor_em_aberto: "100,00" }])).toMatchObject({ stage: "agreement", settled: false, unknown_values: [] });
    expect(interpretSituation([{ situacao_acordo: "Quitado" }])).toMatchObject({ stage: "paid", settled: true });
    expect(interpretSituation([{ situacao_acordo: "novo-status" }])).toMatchObject({ stage: "unknown", settled: false, unknown_values: ["novo-status"] });
    expect(interpretSituation([{ instituicao: "X" }])).toMatchObject({ stage: "none", settled: false });
  });
});

// ---------- Detecção por consulta à DDM ----------
interface Call {
  table: string;
  op: "select" | "update";
  filters: Record<string, unknown>;
  payload?: Record<string, unknown>;
  or?: string;
}

function fakeDb(handler: (c: Call) => { data?: unknown; error?: { code?: string } | null }) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: {} };
      const chain: Record<string, unknown> = {};
      const run = () => {
        calls.push(call);
        const out = handler(call);
        return { data: out.data ?? null, error: out.error ?? null };
      };
      for (const m of ["select", "order", "limit", "gt", "lte", "not", "is"]) chain[m] = () => chain;
      chain.eq = (k: string, v: unknown) => ((call.filters[k] = v), chain);
      chain.in = (k: string, v: unknown) => ((call.filters[k] = v), chain);
      chain.or = (v: string) => ((call.or = v), chain);
      chain.update = (p: Record<string, unknown>) => ((call.op = "update"), (call.payload = p), chain);
      chain.maybeSingle = async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      };
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
      return chain;
    },
  };
  return { db: db as never, calls };
}

const NOW = new Date("2026-10-14T12:00:00.000Z");
const link = (tid: string, contact: string, over: Record<string, unknown> = {}) => ({
  tid,
  account_id: "acc",
  campaign_id: "camp",
  contact_id: contact,
  created_at: "2026-10-12T10:00:00.000Z",
  clicou_em: "2026-10-12T10:05:00.000Z",
  fechou_em: null,
  pagou_em: null,
  pagou_evento_em: null,
  verificado_em: null,
  ...over,
});
const sit = (stage: DdmSituation["stage"], text: string | null = null, extra: Partial<DdmSituation> = {}): DdmSituation => ({
  situacao_acordo: text,
  valor_em_aberto: 500,
  instituicao: "Instituição X",
  stage,
  settled: stage === "paid",
  unknown_values: [],
  ...extra,
});
const updates = (calls: Call[]) => calls.filter((c) => c.table === "utmpay_links" && c.op === "update");

function dbFor(links: unknown[], cpfs: Record<string, string | null>, msgs: unknown[] = []) {
  return fakeDb((c) => {
    if (c.table === "utmpay_links" && c.op === "select") return { data: links };
    if (c.table === "contacts") return { data: Object.entries(cpfs).map(([id, cpf]) => ({ id, cpf })) };
    if (c.table === "conversations") return { data: [{ id: "conv" }] };
    if (c.table === "messages") return { data: msgs };
    return {};
  });
}

describe("detectFromDdm (fechou/pagou por consulta à DDM)", () => {
  beforeEach(() => resetUnknownSituacaoLog());

  it("acordo em andamento ⇒ fechou_em (momento da detecção) com a atribuição da conversa; não marca pagou", async () => {
    const t = dbFor(
      [link("t1", "c1")],
      { c1: "123.456.789-09" },
      [
        { sender_type: "customer", origin: "customer", created_at: "2026-10-13T10:00:00Z", sender_id: null },
        { sender_type: "agent", origin: "operator", created_at: "2026-10-13T10:05:00Z", sender_id: "ana" },
      ],
    );
    const situation = vi.fn(async (cpf: string) => (void cpf, sit("agreement", "Acordo na DDM")));
    const r = await detectFromDdm(t.db, { situation }, { now: NOW });
    expect(r).toEqual({ checked: 1, fechou: 1, pagou: 0, unknown: 0 });
    expect(situation).toHaveBeenCalledWith("12345678909");
    const patch = updates(t.calls)[0].payload!;
    expect(patch).toMatchObject({ fechou_em: NOW.toISOString(), atribuicao: "humano", atendente_id: "ana", situacao_acordo: "Acordo na DDM", verificado_em: NOW.toISOString() });
    expect(patch).not.toHaveProperty("pagou_em");
  });

  it("quitado ⇒ pagou_em (e fechou_em se vazio); fechou_em já existente (do webhook) NÃO é sobrescrito", async () => {
    const a = dbFor([link("t1", "c1")], { c1: "12345678909" });
    expect(await detectFromDdm(a.db, { situation: async () => sit("paid", "Quitado") }, { now: NOW })).toEqual({ checked: 1, fechou: 1, pagou: 1, unknown: 0 });
    expect(updates(a.calls)[0].payload).toMatchObject({ fechou_em: NOW.toISOString(), pagou_em: NOW.toISOString(), atribuicao: "direto" });

    const b = dbFor([link("t2", "c2", { fechou_em: "2026-10-13T09:00:00.000Z" })], { c2: "11144477735" });
    expect(await detectFromDdm(b.db, { situation: async () => sit("paid", "Quitado") }, { now: NOW })).toEqual({ checked: 1, fechou: 0, pagou: 1, unknown: 0 });
    const patch = updates(b.calls)[0].payload!;
    expect(patch).toMatchObject({ pagou_em: NOW.toISOString() });
    expect(patch).not.toHaveProperty("fechou_em");
  });

  it("sem acordo (none) e valor DESCONHECIDO: não marcam nada; o desconhecido é logado uma vez", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const none = dbFor([link("t1", "c1")], { c1: "12345678909" });
    expect(await detectFromDdm(none.db, { situation: async () => sit("none", "Em aberto") }, { now: NOW })).toEqual({ checked: 1, fechou: 0, pagou: 0, unknown: 0 });
    expect(updates(none.calls)[0].payload).not.toHaveProperty("fechou_em");

    const unk = dbFor([link("t1", "c1"), link("t2", "c2")], { c1: "12345678909", c2: "11144477735" });
    const r = await detectFromDdm(unk.db, { situation: async () => sit("unknown", "status-novo", { unknown_values: ["status-novo"] }) }, { now: NOW });
    expect(r).toEqual({ checked: 2, fechou: 0, pagou: 0, unknown: 2 });
    for (const u of updates(unk.calls)) expect(u.payload).not.toHaveProperty("fechou_em");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("situacao_acordo desconhecida"))).toHaveLength(1); // 1x só
    warn.mockRestore();
  });

  it("um CPF por execução (o link de clique mais recente) e o limite do lote", async () => {
    const t = dbFor(
      [link("novo", "c1", { clicou_em: "2026-10-13T10:00:00.000Z" }), link("velho", "c1b"), link("outro", "c2"), link("terceiro", "c3")],
      { c1: "12345678909", c1b: "123.456.789-09", c2: "11144477735", c3: "52998224725" },
    );
    const situation = vi.fn(async (cpf: string) => (void cpf, sit("agreement", "Acordo na DDM")));
    const r = await detectFromDdm(t.db, { situation }, { now: NOW, limit: 2 });
    expect(r.checked).toBe(2); // limite
    expect(situation.mock.calls.map((c) => c[0])).toEqual(["12345678909", "11144477735"]); // c1b = mesmo CPF de c1: pulado
    expect(updates(t.calls).map((u) => u.filters.tid)).toEqual(["novo", "outro"]);
  });

  it("só quem está DENTRO da janela da conta (7 dias padrão) e tem CPF válido é consultado", async () => {
    const t = dbFor(
      [link("fora", "c1", { created_at: "2026-10-01T10:00:00.000Z" }), link("sem-cpf", "c2"), link("dentro", "c3")],
      { c1: "12345678909", c2: null, c3: "52998224725" },
    );
    const situation = vi.fn(async (cpf: string) => (void cpf, sit("agreement", "Acordo na DDM")));
    const r = await detectFromDdm(t.db, { situation }, { now: NOW });
    expect(r.checked).toBe(1);
    expect(situation).toHaveBeenCalledWith("52998224725");
    // janela maior por conta: o link de 13 dias entra
    const wide = dbFor([link("fora", "c1", { created_at: "2026-10-01T10:00:00.000Z" })], { c1: "12345678909" });
    const s2 = vi.fn(async (cpf: string) => (void cpf, sit("none")));
    await detectFromDdm(wide.db, { situation: s2, windowDays: async () => 30 }, { now: NOW });
    expect(s2).toHaveBeenCalledTimes(1);
  });

  it("a consulta pede só quem clicou, sem pagou_em, ordenado pelo clique mais recente e sem repetir quem foi verificado há pouco", async () => {
    const t = dbFor([], {});
    await detectFromDdm(t.db, { situation: vi.fn() }, { now: NOW });
    const q = t.calls[0];
    expect(q.table).toBe("utmpay_links");
    expect(q.or).toBe(`verificado_em.is.null,verificado_em.lt.${new Date(NOW.getTime() - 60 * 60_000).toISOString()}`);
  });

  it("DDM fora do ar para um CPF: segue com os outros e não marca nada naquele", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = dbFor([link("a", "c1"), link("b", "c2")], { c1: "12345678909", c2: "11144477735" });
    const situation = vi.fn().mockRejectedValueOnce(new Error("DDM fora")).mockResolvedValueOnce(sit("agreement", "Acordo na DDM"));
    const r = await detectFromDdm(t.db, { situation }, { now: NOW });
    expect(r).toEqual({ checked: 1, fechou: 1, pagou: 0, unknown: 0 });
    expect(updates(t.calls).map((u) => u.filters.tid)).toEqual(["b"]);
  });

  it("nenhum candidato: nada a consultar", async () => {
    const situation = vi.fn();
    expect(await detectFromDdm(dbFor([], {}).db, { situation }, { now: NOW })).toEqual({ checked: 0, fechou: 0, pagou: 0, unknown: 0 });
    expect(situation).not.toHaveBeenCalled();
  });
});
