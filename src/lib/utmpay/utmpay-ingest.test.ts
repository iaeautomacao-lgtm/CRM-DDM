import { describe, expect, it, vi } from "vitest";

import { enrichFromEvent, recheckPendingPayments, recordUtmpayEvent, type LinkRow } from "./ingest";
import { parseUtmpayEvent } from "./events";
import { interpretSituation } from "@/lib/billing/ddm-source";

interface Call {
  table: string;
  op: "select" | "insert" | "update";
  filters: Record<string, unknown>;
  payload?: Record<string, unknown>;
  or?: string;
}

/** Banco falso: registra as chamadas; responde por tabela/op. */
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
      chain.insert = (p: Record<string, unknown>) => ((call.op = "insert"), (call.payload = p), chain);
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

const link: LinkRow = { tid: "t1", account_id: "acc", campaign_id: "camp", contact_id: "c1", created_at: "2026-10-01T10:00:00.000Z", clicou_em: null, fechou_em: null, pagou_em: null, pagou_evento_em: null };
const ev = (etapa: string, at = "2026-10-02T10:00:00Z") => {
  const r = parseUtmpayEvent(JSON.stringify({ event_id: "123e4567-e89b-42d3-a456-426614174000", tid: "t1", etapa, occurred_at: at, codigo: "cd", campanha: "C", canal: "whatsapp" }));
  if (!r.ok) throw new Error(r.error);
  return r.event;
};
const updates = (calls: Call[]) => calls.filter((c) => c.table === "utmpay_links" && c.op === "update");

describe("recordUtmpayEvent", () => {
  it("grava o evento e o 1º clique (só se a coluna está vazia ou o novo é mais antigo)", async () => {
    const t = fakeDb(() => ({}));
    expect(await recordUtmpayEvent(t.db, link, ev("click"), 7)).toEqual({ duplicate: false, inWindow: true });
    const inserted = t.calls.find((c) => c.op === "insert")!.payload!;
    expect(inserted).toMatchObject({ event_id: "123e4567-e89b-42d3-a456-426614174000", account_id: "acc", tid: "t1", etapa: "click", in_window: true, codigo: "cd" });
    const up = updates(t.calls)[0];
    expect(up.payload).toEqual({ clicou_em: "2026-10-02T10:00:00.000Z" });
    expect(up.or).toBe("clicou_em.is.null,clicou_em.gt.2026-10-02T10:00:00.000Z");
  });
  it("idempotente: o mesmo event_id (23505) não grava de novo nem mexe no envio", async () => {
    const t = fakeDb((c) => (c.op === "insert" ? { error: { code: "23505" } } : {}));
    expect(await recordUtmpayEvent(t.db, link, ev("payment_start"), 7)).toEqual({ duplicate: true, inWindow: true });
    expect(updates(t.calls)).toHaveLength(0);
  });
  it("payment_start marca fechou_em; paid marca só pagou_evento_em (pagou_em depende da DDM)", async () => {
    const a = fakeDb(() => ({}));
    await recordUtmpayEvent(a.db, link, ev("payment_start"), 7);
    expect(updates(a.calls)[0].payload).toEqual({ fechou_em: "2026-10-02T10:00:00.000Z" });
    const b = fakeDb(() => ({}));
    await recordUtmpayEvent(b.db, link, ev("paid"), 7);
    expect(updates(b.calls)[0].payload).toEqual({ pagou_evento_em: "2026-10-02T10:00:00.000Z" });
    expect(updates(b.calls).some((u) => "pagou_em" in (u.payload ?? {}))).toBe(false);
  });
  it("fora da janela de 7 dias: o evento fica gravado (in_window=false) mas não vira fechou/pagou; o clique continua valendo", async () => {
    const late = "2026-10-20T10:00:00Z";
    const t = fakeDb(() => ({}));
    expect(await recordUtmpayEvent(t.db, link, ev("payment_start", late), 7)).toEqual({ duplicate: false, inWindow: false });
    expect(t.calls.find((c) => c.op === "insert")!.payload).toMatchObject({ in_window: false });
    expect(updates(t.calls)).toHaveLength(0);
    const c = fakeDb(() => ({}));
    await recordUtmpayEvent(c.db, link, ev("click", late), 7);
    expect(updates(c.calls)).toHaveLength(1);
  });
  it("etapas intermediárias só ficam no histórico de eventos", async () => {
    const t = fakeDb(() => ({}));
    await recordUtmpayEvent(t.db, link, ev("cpf_view"), 7);
    expect(updates(t.calls)).toHaveLength(0);
  });
  it("erro de banco lança (a rota responde 500 e o UTMpay repete com o MESMO event_id)", async () => {
    await expect(recordUtmpayEvent(fakeDb((c) => (c.op === "insert" ? { error: { code: "XX" } } : {})).db, link, ev("click"), 7)).rejects.toThrow();
  });
});

const messages = (...rows: [string, string | null, string, string | null][]) => rows.map(([sender_type, origin, created_at, sender_id]) => ({ sender_type, origin, created_at, sender_id }));

function enrichDb(opts: { msgs?: unknown[]; cpf?: string | null } = {}) {
  return fakeDb((c) => {
    if (c.table === "conversations") return { data: [{ id: "conv1" }] };
    if (c.table === "messages") return { data: opts.msgs ?? [] };
    if (c.table === "contacts") return { data: { cpf: opts.cpf === undefined ? "123.456.789-09" : opts.cpf } };
    return {};
  });
}
const settled = { situacao_acordo: "PAGO", valor_em_aberto: 0, instituicao: "Instituição X", settled: true };
const openDebt = { situacao_acordo: "Em aberto", valor_em_aberto: 500, instituicao: "Instituição X", settled: false };

describe("enrichFromEvent (atribuição + API DDM)", () => {
  it("payment_start: atribui pela conversa (humano vence IA, último atendente) e grava a situação da DDM", async () => {
    const t = enrichDb({
      msgs: messages(["customer", "customer", "2026-10-01T11:00:00Z", null], ["agent", "ai", "2026-10-01T11:01:00Z", null], ["agent", "operator", "2026-10-01T12:00:00Z", "ana"]),
    });
    await enrichFromEvent(t.db, link, ev("payment_start"), true, { situation: async () => openDebt }, new Date("2026-10-02T11:00:00Z"));
    const patch = updates(t.calls)[0].payload!;
    expect(patch).toMatchObject({ atribuicao: "humano", atendente_id: "ana", situacao_acordo: "Em aberto", valor_em_aberto: 500, instituicao: "Instituição X", verificado_em: "2026-10-02T11:00:00.000Z" });
    expect(patch).not.toHaveProperty("pagou_em");
    // as mensagens são buscadas pelas conversas DO contato, entre o envio e o evento
    const q = t.calls.find((c) => c.table === "messages")!;
    expect(q.filters.conversation_id).toEqual(["conv1"]);
  });
  it("paid CONFIRMADO pela DDM ⇒ pagou_em; paid NÃO confirmado ⇒ continua pendente (sem pagou_em)", async () => {
    const yes = enrichDb();
    await enrichFromEvent(yes.db, link, ev("paid"), true, { situation: async () => settled });
    expect(updates(yes.calls)[0].payload).toMatchObject({ pagou_em: "2026-10-02T10:00:00.000Z", atribuicao: "direto" });
    const no = enrichDb();
    await enrichFromEvent(no.db, link, ev("paid"), true, { situation: async () => openDebt });
    expect(updates(no.calls)[0].payload).not.toHaveProperty("pagou_em");
  });
  it("DDM fora do ar / sem CPF: grava só a atribuição e o paid fica pendente (não perde o evento)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = enrichDb();
    await enrichFromEvent(down.db, link, ev("paid"), true, { situation: async () => { throw new Error("DDM fora"); } });
    expect(updates(down.calls)[0].payload).toEqual({ atribuicao: "direto", atendente_id: null });
    const noCpf = enrichDb({ cpf: null });
    const situation = vi.fn();
    await enrichFromEvent(noCpf.db, link, ev("paid"), true, { situation });
    expect(situation).not.toHaveBeenCalled();
  });
  it("evento fora da janela ou de outra etapa não enriquece", async () => {
    const t = enrichDb();
    await enrichFromEvent(t.db, link, ev("paid"), false, { situation: async () => settled });
    await enrichFromEvent(t.db, link, ev("click"), true, { situation: async () => settled });
    expect(t.calls).toHaveLength(0);
  });
});

describe("recheckPendingPayments", () => {
  it("confirma os paid pendentes quando a DDM passa a confirmar e segue quando falha", async () => {
    const rows = [
      { tid: "a", account_id: "acc", contact_id: "c1", pagou_evento_em: "2026-10-10T10:00:00Z" },
      { tid: "b", account_id: "acc", contact_id: "c2", pagou_evento_em: "2026-10-10T11:00:00Z" },
      { tid: "c", account_id: "acc", contact_id: "c3", pagou_evento_em: "2026-10-10T12:00:00Z" },
    ];
    const t = fakeDb((c) => (c.table === "utmpay_links" && c.op === "select" ? { data: rows } : c.table === "contacts" ? { data: { cpf: "12345678909" } } : {}));
    const situation = vi.fn().mockResolvedValueOnce(settled).mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(openDebt);
    const r = await recheckPendingPayments(t.db, { situation }, { now: new Date("2026-10-11T00:00:00Z") });
    expect(r).toEqual({ checked: 3, confirmed: 1 });
    const ups = updates(t.calls);
    expect(ups[0].payload).toMatchObject({ pagou_em: "2026-10-10T10:00:00Z" });
    expect(ups[0].filters.tid).toBe("a");
    expect(ups[1].payload).not.toHaveProperty("pagou_em");
  });
});

describe("interpretSituation (API DDM localiza_dev)", () => {
  it("lista vazia = sem dívida ativa = quitada", () => {
    expect(interpretSituation([])).toEqual({ situacao_acordo: null, valor_em_aberto: 0, instituicao: null, settled: true });
  });
  it("lê situacao_acordo, valor_em_aberto (soma) e instituicao", () => {
    const s = interpretSituation([
      { situacao_acordo: "Acordo vigente", valor_em_aberto: "1.234,50", instituicao: "Cruzeiro" },
      { situacao_acordo: "", valor_em_aberto: 100, apelido: "Outra" },
    ]);
    expect(s).toEqual({ situacao_acordo: "Acordo vigente", valor_em_aberto: 1334.5, instituicao: "Cruzeiro", settled: false });
  });
  it("só é quitada se TODA dívida listada estiver paga/quitada", () => {
    expect(interpretSituation([{ situacao_acordo: "Pago" }, { situacao_acordo: "Quitado" }]).settled).toBe(true);
    expect(interpretSituation([{ situacao_acordo: "Pago" }, { situacao_acordo: "Em aberto" }]).settled).toBe(false);
    expect(interpretSituation([{ instituicao: "X" }]).settled).toBe(false);
  });
  it("resposta que não é lista é erro", () => {
    expect(() => interpretSituation({ erro: 1 })).toThrow();
  });
});
