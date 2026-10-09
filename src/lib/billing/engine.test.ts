import { beforeEach, describe, expect, it, vi } from "vitest";

const writeLog = vi.fn(async () => {});
vi.mock("@/lib/logger", () => ({ writeLog: (...a: unknown[]) => (writeLog as unknown as (...x: unknown[]) => unknown)(...a) }));
const checkDebtById = vi.fn();
const enrollOpenDebts = vi.fn(async () => 2);
const precheckUpcoming = vi.fn(async () => ({ candidates: 3, checked: 2, stopped: 1, deferred: 0, fresh: 0 }));
vi.mock("./sync", () => ({
  checkDebtById: (...a: unknown[]) => checkDebtById(...a),
  enrollOpenDebts: (...a: unknown[]) => (enrollOpenDebts as unknown as (...x: unknown[]) => unknown)(...a),
  precheckUpcoming: (...a: unknown[]) => (precheckUpcoming as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { brasiliaDate, previewRuler, runBillingTick, RETRY_ENQUEUE_MS, RETRY_SOURCE_MS } = await import("./engine");

const A = "A";
const NOW = new Date("2026-10-19T12:00:00Z");
const source = { name: "ddm", getStatus: vi.fn() };

type Rpc = Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }>;
let rpcs: Rpc;
let rulersResult: unknown[];
let tableCalls: Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, ...unknown[]]> }>;
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;

const step = (id: string, over: Record<string, unknown> = {}) => ({
  send_id: `s-${id}`, enrollment_id: `e-${id}`, step_id: "st", account_id: A, ruler_id: "R1", debt_id: `d-${id}`, contact_id: `c-${id}`, channel_id: null,
  send_key: `regua:e-${id}:st`, due_at: NOW.toISOString(), template_id: null, message_text: "oi", due_date: "2026-10-19", amount_cents: 100, external_ref: id, ...over,
});

function fakeDb() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const handler = rpcs[fn];
      const out = handler ? handler(args) : { data: null };
      return { data: out.data ?? null, error: out.error ?? null };
    }),
    from: (table: string) => {
      const call = { table, op: "select", filters: [] as Array<[string, ...unknown[]]>, payload: undefined as unknown };
      tableCalls.push(call);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = (p: unknown) => ((call.op = "update"), (call.payload = p), b);
      b.delete = () => ((call.op = "delete"), b);
      for (const m of ["eq", "in"]) b[m] = (...args: unknown[]) => (call.filters.push([m, ...args]), b);
      b.then = (resolve: (v: unknown) => void) => resolve({ data: table === "billing_rulers" ? rulersResult : [], error: null });
      return b;
    },
  };
}

const deps = (over: Record<string, unknown> = {}) =>
  ({ db: fakeDb() as never, sourceFor: () => source as never, enqueuer: null, now: () => NOW, ...over }) as Parameters<typeof runBillingTick>[0];

beforeEach(() => {
  rpcs = {};
  rulersResult = [];
  tableCalls = [];
  rpcCalls = [];
  writeLog.mockClear();
  checkDebtById.mockReset();
  enrollOpenDebts.mockClear();
  precheckUpcoming.mockClear();
});

describe("runBillingTick", () => {
  it("sem régua ativa: não faz nada", async () => {
    const out = await runBillingTick(deps());
    expect(out).toMatchObject({ accounts: 0, rulers: 0, errors: 0 });
    expect(rpcCalls).toEqual([]);
    expect(writeLog).not.toHaveBeenCalled();
  });

  it("régua em DRY-RUN: para blacklist, inscreve, confere a fonte e CONTA — não reserva nada (nenhum claim)", async () => {
    rulersResult = [{ id: "R1", account_id: A, dry_run: true }];
    rpcs.billing_stop_blacklisted = () => ({ data: 3 });
    rpcs.billing_dry_run = () => ({ data: [{ step_id: "x", offset_days: 0, debts: 4 }, { step_id: "y", offset_days: 2, debts: "6" }] });
    const out = await runBillingTick(deps());
    expect(out).toMatchObject({ accounts: 1, rulers: 1, stopped_blacklist: 3, enrolled: 2, dry_run: { R1: 10 }, precheck: { checked: 2, stopped: 1 } });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["billing_stop_blacklisted", "billing_dry_run"]);
    expect(rpcCalls[1].args).toEqual({ p_account: A, p_ruler: "R1", p_date: "2026-10-19" });
    expect(rpcCalls.some((c) => c.fn === "billing_claim_due_steps")).toBe(false);
    expect(writeLog).toHaveBeenCalledTimes(1); // um log por tick com atividade, só contagens
    expect(JSON.stringify(writeLog.mock.calls[0])).not.toMatch(/cpf|phone|telefone/i);
  });

  it("régua AO VIVO sem enqueuer ou sem fonte: fail-closed (nenhum claim, nada reservado)", async () => {
    rulersResult = [{ id: "R1", account_id: A, dry_run: false }];
    const noEnqueuer = await runBillingTick(deps({ enqueuer: null }));
    expect(noEnqueuer.skipped_live_no_enqueuer).toBe(1);
    const noSource = await runBillingTick(deps({ enqueuer: { enqueue: vi.fn() }, sourceFor: () => null }));
    expect(noSource.skipped_live_no_source).toBe(1);
    expect(rpcCalls.some((c) => c.fn === "billing_claim_due_steps")).toBe(false);
  });

  describe("ao vivo", () => {
    const enqueuer = (impl: (steps: unknown[]) => unknown[]) => ({ enqueue: vi.fn(async (_a: string, steps: unknown[]) => impl(steps)) });
    beforeEach(() => {
      rulersResult = [{ id: "R1", account_id: A, dry_run: false }];
      rpcs.billing_stop_blacklisted = () => ({ data: 0 });
      rpcs.billing_should_send = () => ({ data: { ok: true, reason: null } });
    });

    it("claim → conferência → guarda → enqueue → marca enqueued com o item da fila", async () => {
      const claim = [step("1"), step("2")];
      rpcs.billing_claim_due_steps = () => ({ data: claim.splice(0) });
      checkDebtById.mockResolvedValue({ send: true, reason: "open" });
      const eq = enqueuer((steps) => (steps as Array<{ send_id: string }>).map((s) => ({ sendId: s.send_id, queueItemId: `q-${s.send_id}` })));
      const out = await runBillingTick(deps({ enqueuer: eq }));
      expect(out.live).toEqual({ claimed: 2, enqueued: 2, cancelled: 0, released: 0 });
      expect(eq.enqueue).toHaveBeenCalledTimes(1);
      expect(rpcCalls.filter((c) => c.fn === "billing_should_send").map((c) => c.args)).toEqual([{ p_send_id: "s-1" }, { p_send_id: "s-2" }]);
      const marks = tableCalls.filter((c) => c.table === "billing_step_sends" && c.op === "update");
      expect(marks.map((m) => (m.payload as { queue_item_id: string }).queue_item_id)).toEqual(["q-s-1", "q-s-2"]);
      expect((marks[0].payload as { status: string }).status).toBe("enqueued");
      expect(marks[0].filters).toEqual(expect.arrayContaining([["eq", "status", "reserved"]]));
    });

    it("pago/acordo/sem CPF/dívida sumida: cancela a etapa (não envia, não desfaz reserva)", async () => {
      const claim = [step("1"), step("2"), step("3")];
      rpcs.billing_claim_due_steps = () => ({ data: claim.splice(0) });
      checkDebtById.mockResolvedValueOnce({ send: false, reason: "paid" }).mockResolvedValueOnce({ send: false, reason: "invalid_document" }).mockResolvedValueOnce({ send: false, reason: "debt_not_found" });
      const eq = enqueuer(() => []);
      const out = await runBillingTick(deps({ enqueuer: eq }));
      expect(out.live).toEqual({ claimed: 3, enqueued: 0, cancelled: 3, released: 0 });
      expect(eq.enqueue).not.toHaveBeenCalled();
      const cancels = tableCalls.filter((c) => c.op === "update").map((c) => (c.payload as { status: string; error_code: string }));
      expect(cancels.map((c) => c.error_code)).toEqual(["paid", "invalid_document", "debt_not_found"]);
      expect(cancels.every((c) => c.status === "cancelled")).toBe(true);
    });

    it("fonte fora do ar (retryable): DESFAZ a reserva, reagenda em 15 min e não insiste nas demais do lote", async () => {
      const claim = [step("1"), step("2"), step("3")];
      rpcs.billing_claim_due_steps = () => ({ data: claim.splice(0) });
      checkDebtById.mockResolvedValueOnce({ send: false, reason: "source_unavailable", retryable: true });
      const eq = enqueuer(() => []);
      const out = await runBillingTick(deps({ enqueuer: eq }));
      expect(out.live).toEqual({ claimed: 3, enqueued: 0, cancelled: 0, released: 3 });
      expect(checkDebtById).toHaveBeenCalledTimes(1); // as outras nem consultaram a fonte
      const deletes = tableCalls.filter((c) => c.op === "delete");
      expect(deletes).toHaveLength(3);
      expect(deletes[0].filters).toEqual(expect.arrayContaining([["eq", "id", "s-1"], ["eq", "status", "reserved"]]));
      const retry = tableCalls.find((c) => c.table === "billing_enrollments" && c.op === "update")!;
      expect((retry.payload as { next_step_at: string }).next_step_at).toBe(new Date(NOW.getTime() + RETRY_SOURCE_MS).toISOString());
      expect(rpcCalls.filter((c) => c.fn === "billing_claim_due_steps")).toHaveLength(1); // não puxa outro lote
    });

    it("a guarda de pré-envio recusa (blacklist/régua desligada…): conta como cancelada e não vai ao disparador", async () => {
      rpcs.billing_claim_due_steps = (() => { const once = [step("1")]; return () => ({ data: once.splice(0) }); })();
      rpcs.billing_should_send = () => ({ data: { ok: false, reason: "blacklisted" } });
      checkDebtById.mockResolvedValue({ send: true, reason: "open" });
      const eq = enqueuer(() => []);
      const out = await runBillingTick(deps({ enqueuer: eq }));
      expect(out.live).toMatchObject({ claimed: 1, cancelled: 1, enqueued: 0 });
      expect(eq.enqueue).not.toHaveBeenCalled();
    });

    it("falha do enqueue (ou item ausente): desfaz a reserva e tenta de novo em 5 min; nunca marca enqueued", async () => {
      rpcs.billing_claim_due_steps = (() => { const once = [step("1"), step("2")]; return () => ({ data: once.splice(0) }); })();
      checkDebtById.mockResolvedValue({ send: true, reason: "open" });
      const eq = enqueuer(() => [{ sendId: "s-1", error: "campanha indisponível" }]); // s-2 nem veio na resposta
      const out = await runBillingTick(deps({ enqueuer: eq }));
      expect(out.live).toEqual({ claimed: 2, enqueued: 0, cancelled: 0, released: 2 });
      const retry = tableCalls.filter((c) => c.table === "billing_enrollments" && c.op === "update");
      expect((retry[0].payload as { next_step_at: string }).next_step_at).toBe(new Date(NOW.getTime() + RETRY_ENQUEUE_MS).toISOString());
      expect(tableCalls.some((c) => c.table === "billing_step_sends" && c.op === "update")).toBe(false);
    });

    it("lote cheio puxa outro lote; vazio encerra; no máximo 5 lotes por tick", async () => {
      rpcs.billing_claim_due_steps = () => ({ data: [step(String(Math.random()))] });
      checkDebtById.mockResolvedValue({ send: true, reason: "open" });
      const eq = enqueuer((steps) => (steps as Array<{ send_id: string }>).map((s) => ({ sendId: s.send_id, queueItemId: "q" })));
      const out = await runBillingTick(deps({ enqueuer: eq }), { claimLimit: 1 });
      expect(out.live.claimed).toBe(5);
      expect(rpcCalls.filter((c) => c.fn === "billing_claim_due_steps")).toHaveLength(5);
    });
  });

  it("erro numa conta não derruba as outras; registra só a mensagem curta", async () => {
    rulersResult = [{ id: "R1", account_id: "A", dry_run: true }, { id: "R2", account_id: "B", dry_run: true }];
    let calls = 0;
    rpcs.billing_stop_blacklisted = () => (++calls === 1 ? { error: { message: "db caiu " + "x".repeat(400) } } : { data: 0 });
    rpcs.billing_dry_run = () => ({ data: [] });
    const out = await runBillingTick(deps());
    expect(out).toMatchObject({ accounts: 2, errors: 1, dry_run: { R2: 0 } });
    const err = (writeLog.mock.calls as unknown as Array<[{ event: string; payload: { erro?: string } }]>).map((c) => c[0]).find((c) => c.event === "billing_tick_error")!;
    expect(err.payload.erro!.length).toBeLessThanOrEqual(200);
  });

  it("filtra por conta e respeita o orçamento de tempo", async () => {
    rulersResult = [{ id: "R1", account_id: A, dry_run: true }];
    rpcs.billing_stop_blacklisted = () => ({ data: 0 });
    rpcs.billing_dry_run = () => ({ data: [] });
    await runBillingTick(deps(), { accountId: A });
    expect(tableCalls[0].filters).toEqual(expect.arrayContaining([["eq", "active", true], ["eq", "account_id", A]]));
    rpcCalls = [];
    expect((await runBillingTick(deps(), { budgetMs: 0 })).accounts).toBe(0);
  });

  it("erro ao listar as réguas sobe (o cron responde 503)", async () => {
    const db = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "relation does not exist" } }) }) }), rpc: vi.fn() };
    await expect(runBillingTick({ ...deps(), db: db as never })).rejects.toMatchObject({ message: "relation does not exist" });
  });
});

describe("utilitários", () => {
  it("brasiliaDate usa UTC-3 (virada do dia)", () => {
    expect(brasiliaDate(new Date("2026-10-19T02:59:00Z"))).toBe("2026-10-18");
    expect(brasiliaDate(new Date("2026-10-19T03:00:00Z"))).toBe("2026-10-19");
  });

  it("previewRuler converte contagens em número e propaga erro", async () => {
    rpcs.billing_dry_run = () => ({ data: [{ step_id: "x", offset_days: 0, debts: "7" }] });
    expect(await previewRuler(fakeDb() as never, A, "R1", "2026-10-22")).toEqual([{ step_id: "x", offset_days: 0, debts: 7 }]);
    rpcs.billing_dry_run = () => ({ error: { message: "boom" } });
    await expect(previewRuler(fakeDb() as never, A, "R1", "2026-10-22")).rejects.toMatchObject({ message: "boom" });
  });
});
