import { beforeEach, describe, expect, it, vi } from "vitest";

import { DebtSourceError, type DebtSource, type DebtStatus } from "./debt-source";
import { checkDebtBeforeSend, checkDebtById, enrollOpenDebts, importDebts, isValidDateOnly, precheckUpcoming, recordSyncRun, validateImportRow, IMPORT_CHUNK } from "./sync";

type Call = { table: string; op: string; payload?: unknown; opts?: unknown; filters: Array<[string, ...unknown[]]>; select?: string };
let calls: Call[] = [];
let results: Record<string, Array<{ data?: unknown; error?: { code?: string; message?: string } | null }>> = {};
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message?: string } | null } = { data: 0, error: null };

function fakeDb() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => (rpcCalls.push({ fn, args }), rpcResult)),
    from: (table: string) => {
      const call: Call = { table, op: "select", filters: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      b.select = (cols?: string) => ((call.select ??= cols), b);
      b.upsert = (payload: unknown, opts?: unknown) => ((call.op = "upsert"), (call.payload = payload), (call.opts = opts), b);
      b.update = (payload: unknown) => ((call.op = "update"), (call.payload = payload), b);
      for (const m of ["eq", "in", "or", "lte", "order", "limit"]) b[m] = (...args: unknown[]) => (call.filters.push([m, ...args]), b);
      b.then = (resolve: (v: unknown) => void) => {
        const queue = results[`${table}:${call.op}`];
        const r = queue && queue.length > 1 ? queue.shift()! : queue?.[0] ?? { data: [], error: null };
        resolve({ data: r.data ?? [], error: r.error ?? null });
      };
      return b;
    },
  };
}
const db = () => fakeDb() as never;
const A = "00000000-0000-0000-0000-00000000000a";
const C1 = "11111111-1111-4111-8111-111111111111";
const DEBT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-19T12:00:00Z");

const source = (status: DebtStatus | Error): DebtSource & { getStatus: ReturnType<typeof vi.fn> } => ({
  name: "ddm",
  getStatus: vi.fn(async () => {
    if (status instanceof Error) throw status;
    return status;
  }),
});

beforeEach(() => {
  calls = [];
  results = {};
  rpcCalls = [];
  rpcResult = { data: 0, error: null };
});

describe("importDebts", () => {
  const row = (over: Record<string, unknown> = {}) => ({ contact_id: C1, external_ref: "1:cruzeiro", due_date: "2026-10-22", amount_cents: 15000, ...over });

  it("upsert por (conta, fonte, ref) SEM a coluna status — a carteira nunca reabre dívida paga", async () => {
    const out = await importDebts(db(), A, [row(), row({ external_ref: "2:cruzeiro", amount_cents: null })], { now: NOW });
    expect(out).toEqual({ received: 2, imported: 2, rejected: [] });
    const up = calls.find((c) => c.op === "upsert")!;
    expect(up.opts).toEqual({ onConflict: "account_id,source,external_ref" });
    const payload = up.payload as Array<Record<string, unknown>>;
    expect(payload[0]).toEqual({ account_id: A, contact_id: C1, source: "ddm", external_ref: "1:cruzeiro", due_date: "2026-10-22", amount_cents: 15000, synced_at: NOW.toISOString() });
    expect(payload.every((p) => !("status" in p))).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/cpf/i);
  });

  it("recusa linha inválida com motivo e importa o resto; índice original preservado", async () => {
    const out = await importDebts(db(), A, [
      row(),
      row({ contact_id: "x" }),
      row({ external_ref: "" }),
      row({ due_date: "2026-02-30" }),
      row({ due_date: "22/10/2026" }),
      row({ amount_cents: -5 }),
      row({ amount_cents: 1.5 }),
      row({ external_ref: "9:x" }),
    ]);
    expect(out.imported).toBe(2);
    expect(out.rejected).toEqual([
      { index: 1, reason: "invalid_contact" },
      { index: 2, reason: "invalid_ref" },
      { index: 3, reason: "invalid_due_date" },
      { index: 4, reason: "invalid_due_date" },
      { index: 5, reason: "invalid_amount" },
      { index: 6, reason: "invalid_amount" },
    ]);
  });

  it("referência repetida no lote vale a última (evita 'row affected twice')", async () => {
    const out = await importDebts(db(), A, [row({ due_date: "2026-10-22" }), row({ due_date: "2026-11-22" })]);
    expect(out.rejected).toEqual([{ index: 0, reason: "duplicate_in_batch" }]);
    expect((calls.find((c) => c.op === "upsert")!.payload as Array<{ due_date: string }>)).toEqual([expect.objectContaining({ due_date: "2026-11-22" })]);
  });

  it("grava em blocos de 1000 e propaga o erro do banco", async () => {
    const many = Array.from({ length: IMPORT_CHUNK * 2 + 5 }, (_, i) => row({ external_ref: `r${i}` }));
    const out = await importDebts(db(), A, many);
    expect(out.imported).toBe(many.length);
    expect(calls.filter((c) => c.op === "upsert").map((c) => (c.payload as unknown[]).length)).toEqual([1000, 1000, 5]);
    results["billing_debts:upsert"] = [{ error: { code: "42P01", message: "relation does not exist" } }];
    await expect(importDebts(db(), A, [row()])).rejects.toMatchObject({ code: "42P01" });
  });

  it("validadores", () => {
    expect(isValidDateOnly("2028-02-29")).toBe(true);
    expect(isValidDateOnly("2027-02-29")).toBe(false);
    expect(validateImportRow(row())).toBeNull();
    expect(validateImportRow({})).toBe("invalid_contact");
  });
});

describe("enrollOpenDebts / recordSyncRun", () => {
  it("chama a RPC da 274 com a conta, a régua e o relógio", async () => {
    rpcResult = { data: 42, error: null };
    expect(await enrollOpenDebts(db(), A, "R1", NOW)).toBe(42);
    expect(rpcCalls[0]).toEqual({ fn: "billing_enroll_open_debts", args: { p_account: A, p_ruler: "R1", p_now: NOW.toISOString() } });
    rpcResult = { data: null, error: { message: "boom" } };
    await expect(enrollOpenDebts(db(), A, "R1")).rejects.toMatchObject({ message: "boom" });
  });

  it("sucesso grava last_success_at; erro NÃO e guarda o texto curto", async () => {
    await recordSyncRun(db(), A, "ddm", { now: NOW });
    await recordSyncRun(db(), A, "ddm", { now: NOW, error: "x".repeat(500) });
    const [ok, fail] = calls.map((c) => c.payload as Record<string, unknown>);
    expect(ok).toMatchObject({ account_id: A, source: "ddm", last_run_at: NOW.toISOString(), last_success_at: NOW.toISOString(), last_error: null });
    expect("last_success_at" in fail).toBe(false);
    expect((fail.last_error as string).length).toBe(300);
    expect(calls[0].opts).toEqual({ onConflict: "account_id,source" });
  });
});

describe("checkDebtBeforeSend (a 'rede de proteção' antes de enfileirar)", () => {
  const debtRow = (over: Record<string, unknown> = {}) => ({ id: DEBT, status: "open", external_ref: "1:cruzeiro", last_checked_at: null, ...over });
  const run = (src: DebtSource, over: Record<string, unknown> = {}) => checkDebtBeforeSend(db(), src, { accountId: A, debtId: DEBT, cpf: "123.456.789-01", now: NOW, ...over });

  it("aberta na fonte: pode enviar e carimba last_checked_at (sem gravar CPF)", async () => {
    results["billing_debts:select"] = [{ data: [debtRow()] }];
    const src = source({ state: "open", amountCents: 20000 });
    expect(await run(src)).toEqual({ send: true, reason: "open" });
    expect(src.getStatus).toHaveBeenCalledWith({ cpf: "12345678901", externalRef: "1:cruzeiro" });
    const update = calls.find((c) => c.op === "update")!;
    expect(update.payload).toEqual({ last_checked_at: NOW.toISOString(), amount_cents: 20000 });
    expect(JSON.stringify(calls)).not.toContain("12345678901");
  });

  it.each([
    ["paid", "paid"],
    ["agreement", "agreement"],
    ["cancelled", "cancelled"],
  ] as const)("fonte diz %s ⇒ NÃO envia e PARA a inscrição (motivo %s)", async (state, reason) => {
    results["billing_debts:select"] = [{ data: [debtRow()] }];
    expect(await run(source({ state }))).toEqual({ send: false, reason });
    expect(rpcCalls).toEqual([{ fn: "billing_stop_enrollments", args: { p_account: A, p_reason: reason, p_debt: DEBT, p_contact: null } }]);
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("consulta recente (TTL) não pergunta de novo à fonte", async () => {
    results["billing_debts:select"] = [{ data: [debtRow({ last_checked_at: new Date(NOW.getTime() - 5 * 60_000).toISOString() })] }];
    const src = source({ state: "paid" });
    expect(await run(src)).toEqual({ send: true, reason: "fresh" });
    expect(src.getStatus).not.toHaveBeenCalled();
    results["billing_debts:select"] = [{ data: [debtRow({ last_checked_at: new Date(NOW.getTime() - 31 * 60_000).toISOString() })] }];
    await run(src);
    expect(src.getStatus).toHaveBeenCalledTimes(1);
  });

  it("fonte fora do ar / limite ⇒ ADIA (send=false), com a flag retryable; nunca envia por precaução", async () => {
    results["billing_debts:select"] = [{ data: [debtRow()] }];
    expect(await run(source(new DebtSourceError("API DDM respondeu HTTP 503")))).toEqual({ send: false, reason: "source_unavailable", retryable: true });
    expect(await run(source(new DebtSourceError("Token ausente", false)))).toEqual({ send: false, reason: "source_unavailable", retryable: false });
    expect(await run(source(new Error("inesperado")))).toEqual({ send: false, reason: "source_unavailable", retryable: true });
    expect(await run(source({ state: "unknown" }))).toEqual({ send: false, reason: "unknown_state" });
    expect(rpcCalls).toEqual([]);
  });

  it("dívida inexistente, já paga/em acordo/cancelada no espelho e sem CPF válido não chegam à fonte", async () => {
    const src = source({ state: "open" });
    results["billing_debts:select"] = [{ data: [] }];
    expect(await run(src)).toEqual({ send: false, reason: "debt_not_found" });
    for (const status of ["paid", "agreement", "cancelled"]) {
      results["billing_debts:select"] = [{ data: [debtRow({ status })] }];
      expect(await run(src)).toEqual({ send: false, reason: `debt_${status}` });
    }
    results["billing_debts:select"] = [{ data: [debtRow()] }];
    expect(await run(src, { cpf: null })).toEqual({ send: false, reason: "invalid_document" });
    expect(await run(src, { cpf: "123" })).toEqual({ send: false, reason: "invalid_document" });
    expect(src.getStatus).not.toHaveBeenCalled();
  });

  it("escopada pela conta e erro de banco sobe (não vira 'pode enviar')", async () => {
    results["billing_debts:select"] = [{ error: { message: "db down" } }];
    await expect(run(source({ state: "open" }))).rejects.toMatchObject({ message: "db down" });
    expect(calls[0].filters).toEqual(expect.arrayContaining([["eq", "account_id", A], ["eq", "id", DEBT]]));
    results["billing_debts:select"] = [{ data: [debtRow()] }];
    rpcResult = { data: null, error: { message: "stop failed" } };
    await expect(run(source({ state: "paid" }))).rejects.toMatchObject({ message: "stop failed" });
  });

  it("checkDebtById lê o CPF do contato só em memória", async () => {
    results["billing_debts:select"] = [{ data: [{ id: DEBT, contacts: { cpf: "123.456.789-01" } }] }, { data: [debtRow()] }];
    const src = source({ state: "open" });
    expect(await checkDebtById(db(), src, A, DEBT, { now: NOW })).toEqual({ send: true, reason: "open" });
    expect(src.getStatus).toHaveBeenCalledWith({ cpf: "12345678901", externalRef: "1:cruzeiro" });
    results["billing_debts:select"] = [{ data: [] }];
    expect(await checkDebtById(db(), src, A, DEBT)).toEqual({ send: false, reason: "debt_not_found" });
  });
});

describe("precheckUpcoming", () => {
  it("confere só as dívidas cuja etapa vence em 24 h e cuja consulta é velha; resume paradas e adiamentos", async () => {
    results["billing_enrollments:select"] = [{ data: [{ debt_id: "d1" }, { debt_id: "d2" }, { debt_id: "d2" }, { debt_id: "d3" }] }];
    results["billing_debts:select"] = [
      { data: [{ id: "d1" }, { id: "d2" }, { id: "d3" }] }, // lista de velhas
      { data: [{ id: "d1", contacts: { cpf: "12345678901" } }] },
      { data: [{ id: "d1", status: "open", external_ref: "r1", last_checked_at: null }] },
      { data: [{ id: "d2", contacts: { cpf: "12345678901" } }] },
      { data: [{ id: "d2", status: "open", external_ref: "r2", last_checked_at: null }] },
      { data: [{ id: "d3", contacts: { cpf: "12345678901" } }] },
      { data: [{ id: "d3", status: "open", external_ref: "r3", last_checked_at: null }] },
    ];
    const states: DebtStatus[] = [{ state: "open" }, { state: "paid" }, { state: "unknown" }];
    const src: DebtSource = { name: "ddm", getStatus: vi.fn(async () => states.shift()!) };
    const out = await precheckUpcoming(db(), src, A, { now: NOW, concurrency: 1 });
    expect(out).toEqual({ candidates: 3, checked: 2, stopped: 1, deferred: 1, fresh: 0 });
    const [enrollCall, staleCall] = calls;
    expect(enrollCall.filters).toEqual(expect.arrayContaining([["eq", "status", "active"], ["lte", "next_step_at", "2026-10-20T12:00:00.000Z"]]));
    expect(staleCall.filters).toEqual(expect.arrayContaining([["eq", "status", "open"], ["in", "id", ["d1", "d2", "d3"]], ["or", "last_checked_at.is.null,last_checked_at.lt.2026-10-19T11:30:00.000Z"]]));
    expect(rpcCalls.map((c) => c.args.p_reason)).toEqual(["paid"]);
  });

  it("limite/queda da fonte (retryable) interrompe o ciclo sem insistir", async () => {
    results["billing_enrollments:select"] = [{ data: [{ debt_id: "d1" }, { debt_id: "d2" }] }];
    results["billing_debts:select"] = [
      { data: [{ id: "d1" }, { id: "d2" }] },
      { data: [{ id: "d1", contacts: { cpf: "12345678901" } }] },
      { data: [{ id: "d1", status: "open", external_ref: "r1", last_checked_at: null }] },
    ];
    const src: DebtSource = { name: "ddm", getStatus: vi.fn(async () => { throw new DebtSourceError("limite", true); }) };
    const out = await precheckUpcoming(db(), src, A, { now: NOW, concurrency: 1 });
    expect(out).toMatchObject({ candidates: 2, deferred: 1, checked: 0 });
    expect(src.getStatus).toHaveBeenCalledTimes(1);
  });

  it("nada devido ⇒ não consulta a fonte", async () => {
    results["billing_enrollments:select"] = [{ data: [] }];
    const src = source({ state: "open" });
    expect(await precheckUpcoming(db(), src, A, { now: NOW })).toEqual({ candidates: 0, checked: 0, stopped: 0, deferred: 0, fresh: 0 });
    expect(src.getStatus).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
