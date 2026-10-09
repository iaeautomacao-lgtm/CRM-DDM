import { beforeEach, describe, expect, it, vi } from "vitest";

const findRedChannels = vi.fn(async () => [] as Array<{ id: string }>);
vi.mock("@/lib/disparador/red-quality-gate", () => ({ findRedChannels: (...a: unknown[]) => (findRedChannels as unknown as (...x: unknown[]) => unknown)(...a) }));

const { createDisparadorEnqueuer, formatAmount, formatDueDate, isVariableSource, renderWahaText, resolveStepVariables } = await import("./enqueuer");

const A = "ACC";
const NOW = new Date("2026-10-19T15:00:00Z");

describe("variáveis da etapa (pura)", () => {
  const ctx = { contact: { name: "Maria Silva", phone: "5521999990001", email: null, company: "ACME" }, debt: { due_date: "2026-10-22", amount_cents: 123456, external_ref: "7:cruzeiro" } };

  it("formata vencimento e valor em pt-BR; centavos inteiros, sem float", () => {
    expect(formatDueDate("2026-10-22")).toBe("22/10/2026");
    expect(formatDueDate("")).toBe("");
    expect(formatAmount(123456)).toBe("1.234,56");
    expect(formatAmount(5)).toBe("0,05");
    expect(formatAmount(100000000)).toBe("1.000.000,00");
    expect(formatAmount(null)).toBe("");
    expect(formatAmount(-1)).toBe("");
  });

  it("resolve contact_field, debt_field e static na ordem do mapa", () => {
    const out = resolveStepVariables(
      [{ type: "contact_field", field: "name" }, { type: "debt_field", field: "due_date" }, { type: "debt_field", field: "amount" }, { type: "static", value: " PIX " }, { type: "debt_field", field: "external_ref" }],
      ctx,
    );
    expect(out).toEqual({ values: ["Maria Silva", "22/10/2026", "1.234,56", "PIX", "7:cruzeiro"], empty: null, invalid: false });
  });

  it("variável vazia é apontada (1-based) para a etapa NÃO sair com buraco", () => {
    expect(resolveStepVariables([{ type: "contact_field", field: "name" }, { type: "contact_field", field: "email" }, { type: "debt_field", field: "amount" }], { ...ctx, debt: { ...ctx.debt, amount_cents: null } })).toMatchObject({ empty: 2 });
    expect(resolveStepVariables([{ type: "static", value: "   " }], ctx).empty).toBe(1);
  });

  it("mapa inválido (campo fora da lista, tipo desconhecido, não é array) ⇒ invalid; mapa vazio é válido", () => {
    expect(resolveStepVariables([{ type: "contact_field", field: "cpf" }], ctx).invalid).toBe(true); // CPF nunca vai para template
    expect(resolveStepVariables([{ type: "sql", q: "x" }], ctx).invalid).toBe(true);
    expect(resolveStepVariables("x", ctx).invalid).toBe(true);
    expect(resolveStepVariables([], ctx)).toEqual({ values: [], empty: null, invalid: false });
    expect(isVariableSource({ type: "static", value: 1 })).toBe(false);
    expect(isVariableSource(null)).toBe(false);
  });

  it("WAHA: troca {{n}}; placeholder sem valor (ou acima do mapa) vira 'missing'", () => {
    expect(renderWahaText("Olá {{1}}, vence em {{2}}.", ["Maria", "22/10/2026"])).toEqual({ text: "Olá Maria, vence em 22/10/2026.", missing: null });
    expect(renderWahaText("Oi {{1}} {{3}}", ["Maria", "x"])).toEqual({ text: "Oi Maria ", missing: 3 });
    expect(renderWahaText("sem variável", []).missing).toBeNull();
  });
});

// ---- enqueue com banco falso -----------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let inserted: Array<{ table: string; rows: Row[] }> = [];
let upserts: Array<{ table: string; row: Row }> = [];
let insertErrors: Record<string, { code?: string; message: string }> = {};
let seq = 0;

function fakeDb() {
  return {
    rpc: vi.fn(),
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      let op = "select";
      let payload: Row | Row[] = [];
      let countHead = false;
      const b: Record<string, unknown> = {};
      b.select = (_c?: string, opts?: { count?: string; head?: boolean }) => ((countHead = Boolean(opts?.head)), b);
      b.insert = (p: Row | Row[]) => ((op = "insert"), (payload = p), b);
      b.upsert = (p: Row) => ((op = "upsert"), (payload = p), b);
      b.eq = (c: string, v: unknown) => (eqs.push([c, v]), b);
      b.in = (c: string, v: unknown[]) => (ins.push([c, v]), b);
      b.limit = () => b;
      b.then = (resolve: (v: unknown) => void) => {
        if (op === "insert") {
          if (insertErrors[table]) return resolve({ data: null, error: insertErrors[table] });
          const rows = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `${table}-${++seq}`, ...r }));
          (tables[table] ??= []).push(...rows);
          inserted.push({ table, rows });
          return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        }
        if (op === "upsert") return (upserts.push({ table, row: payload as Row }), resolve({ data: null, error: null }));
        const rows = (tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, v]) => v.includes(r[c])));
        resolve(countHead ? { data: null, count: rows.length, error: null } : { data: rows, error: null });
      };
      return b;
    },
  };
}

const step = (n: string, over: Record<string, unknown> = {}) => ({
  send_id: `s${n}`, enrollment_id: `e${n}`, step_id: "ST1", account_id: A, ruler_id: "R1", debt_id: `d${n}`, contact_id: `c${n}`, channel_id: "CH1",
  send_key: `regua:e${n}:ST1`, due_at: NOW.toISOString(), template_id: "T1", message_text: null, due_date: "2026-10-22", amount_cents: 15000, external_ref: `ref${n}`, ...over,
});

beforeEach(() => {
  seq = 0;
  inserted = [];
  upserts = [];
  insertErrors = {};
  findRedChannels.mockReset();
  findRedChannels.mockResolvedValue([]);
  tables = {
    billing_ruler_steps: [{ id: "ST1", account_id: A, variable_map: [{ type: "contact_field", field: "name" }, { type: "debt_field", field: "due_date" }], message_text: "Olá {{1}}, vence em {{2}}", template_id: "T1" }],
    billing_rulers: [{ id: "R1", account_id: A, name: "Padrão", window_start: "08:00:00", window_end: "20:00:00", weekdays: [1, 2, 3, 4, 5] }],
    whatsapp_config: [{ id: "CH1", account_id: A, provider: "meta" }, { id: "CHW", account_id: A, provider: "waha" }],
    contacts: [
      { id: "c1", account_id: A, name: "Maria", phone: "5521999990001", email: null, company: null },
      { id: "c2", account_id: A, name: "João", phone: "5521999990002", email: null, company: null },
      { id: "c3", account_id: A, name: null, phone: "5521999990003", email: null, company: null },
      { id: "c4", account_id: A, name: "Sem Fone", phone: null, email: null, company: null },
    ],
    message_templates: [{ id: "T1", account_id: A, name: "cobranca_vencimento", language: "pt_BR", status: "Approved" }, { id: "T2", account_id: A, name: "pendente", language: "pt_BR", status: "Pending" }],
    accounts: [{ id: A, owner_user_id: "OWNER" }],
    campaigns: [],
    disp_message_queue: [],
  };
});

const enqueue = (steps: ReturnType<typeof step>[]) => createDisparadorEnqueuer(fakeDb() as never, { now: () => NOW }).enqueue(A, steps as never);

describe("createDisparadorEnqueuer", () => {
  it("canal META: item da fila com template + variáveis em array, origem 'regua', contact_id e telefone em mensagem_final", async () => {
    const out = await enqueue([step("1")]);
    expect(out).toEqual([{ sendId: "s1", queueItemId: expect.stringMatching(/^disp_message_queue-/) }]);
    const row = inserted.find((i) => i.table === "disp_message_queue")!.rows[0];
    expect(row).toMatchObject({
      account_id: A, contact_id: "c1", session_id: "CH1", status: "agendado", erro_permanente: false, origem: "regua", scheduled_at: NOW.toISOString(),
      template_name: "cobranca_vencimento", template_language: "pt_BR", template_variables: ["Maria", "22/10/2026"], mensagem_final: "5521999990001",
    });
    expect(row.campaign_id).toBeTruthy();
  });

  it("canal WAHA: texto livre com {{n}} trocados no código (sem template), mensagem_final = texto final", async () => {
    const out = await enqueue([step("1", { channel_id: "CHW" })]);
    expect(out[0]).toMatchObject({ queueItemId: expect.any(String) });
    expect(inserted.find((i) => i.table === "disp_message_queue")!.rows[0]).toMatchObject({
      session_id: "CHW", mensagem_final: "Olá Maria, vence em 22/10/2026", template_name: null, template_language: null, template_variables: null, origem: "regua",
    });
  });

  it("UMA campanha-sistema por (régua, canal, dia): origem 'regua', janela da régua, dono da conta; reaproveitada no mesmo dia", async () => {
    await enqueue([step("1"), step("2", { contact_id: "c2" })]);
    await enqueue([step("3", { contact_id: "c2" })]);
    expect(tables.campaigns).toHaveLength(1);
    expect(tables.campaigns[0]).toMatchObject({
      origem: "regua", status: "em_execucao", account_id: A, session_ids: ["CH1"], janela_inicio: "08:00", janela_fim: "20:00", dias_envio: [1, 2, 3, 4, 5],
      idempotency_key: "regua:R1:CH1:2026-10-19", created_by: "OWNER", nome: "Régua — Padrão — 2026-10-19",
    });
    const queue = tables.disp_message_queue;
    expect(queue).toHaveLength(3);
    expect(new Set(queue.map((q) => q.campaign_id)).size).toBe(1);
    expect(upserts.at(-1)).toMatchObject({ table: "campaign_metrics", row: { total_contatos: 3, account_id: A } });
  });

  it("variável vazia, template não aprovado/inexistente, sem telefone e mapa inválido ⇒ CANCELA a etapa (nada vai à fila)", async () => {
    tables.billing_ruler_steps.push(
      { id: "ST2", account_id: A, variable_map: [], message_text: null, template_id: "T2" },
      { id: "ST3", account_id: A, variable_map: [], message_text: null, template_id: "NAO_EXISTE" },
      { id: "ST4", account_id: A, variable_map: [{ type: "contact_field", field: "cpf" }], message_text: null, template_id: "T1" },
    );
    const out = await enqueue([
      step("1", { contact_id: "c3" }), // sem nome ⇒ variável 1 vazia
      step("2", { step_id: "ST2" }),
      step("3", { step_id: "ST3" }),
      step("4", { contact_id: "c4" }),
      step("5", { step_id: "ST4", contact_id: "c1" }),
    ]);
    expect(out.map((r) => (r as { cancelled?: string }).cancelled)).toEqual(["empty_variable_1", "template_not_approved", "template_not_found", "contact_without_phone", "invalid_variable_map"]);
    expect(inserted.filter((i) => i.table === "disp_message_queue")).toEqual([]);
    expect(tables.campaigns).toHaveLength(0);
  });

  it("número em qualidade VERMELHA: blocked 'quality' (a régua nunca confirma RED) e nada é enfileirado nele", async () => {
    findRedChannels.mockResolvedValue([{ id: "CH1" }]);
    const out = await enqueue([step("1"), step("2", { channel_id: "CHW" })]);
    expect(out[0]).toEqual({ sendId: "s1", blocked: "quality" });
    expect(out[1]).toMatchObject({ sendId: "s2", queueItemId: expect.any(String) }); // outro canal segue
    expect(findRedChannels).toHaveBeenCalledWith(expect.anything(), A, expect.arrayContaining(["CH1", "CHW"]));
  });

  it("régua sem canal / etapa inexistente / falha do banco ⇒ erro transitório (a reserva volta e tenta de novo)", async () => {
    expect(await enqueue([step("1", { channel_id: null })])).toEqual([{ sendId: "s1", error: "régua sem canal configurado" }]);
    expect(await enqueue([step("1", { step_id: "NAO" })])).toEqual([{ sendId: "s1", error: "etapa ou régua não encontrada" }]);
    insertErrors.disp_message_queue = { message: "db caiu com senha=abc" };
    const out = await enqueue([step("1")]);
    expect(out).toEqual([{ sendId: "s1", error: "falha ao enfileirar no disparador" }]);
    expect(JSON.stringify(out)).not.toContain("senha");
  });

  it("escopa tudo pela conta: etapa/template/contato de outra conta não são usados", async () => {
    tables.message_templates = [{ id: "T1", account_id: "OUTRA", name: "alheio", language: "pt_BR", status: "Approved" }];
    expect((await enqueue([step("1")]))[0]).toMatchObject({ cancelled: "template_not_found" });
  });

  it("lista vazia não consulta nada", async () => {
    expect(await enqueue([])).toEqual([]);
    expect(inserted).toEqual([]);
  });
});
