// PRD 17.5 — regras da API da régua: validação de entrada, regra de canal (Meta × WAHA), ligar/apagar e controle manual de inscrição.
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ApiError } from "@/lib/api/v1/respond";

import {
  checkStepsAgainstChannel,
  controlEnrollment,
  createRuler,
  decodeCursor,
  deleteRuler,
  dryRun,
  encodeCursor,
  listEnrollments,
  maxPlaceholder,
  parseCivilDate,
  parseReason,
  parseRulerInput,
  parseStepsInput,
  replaceSteps,
  rulerMetrics,
  updateRuler,
  type Db,
  type RulerRow,
  type StepInput,
} from "./ruler-api";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const R1 = "10000000-0000-0000-0000-000000000001";
const CH_META = "20000000-0000-0000-0000-000000000001";
const CH_WAHA = "20000000-0000-0000-0000-000000000002";
const CH_OTHER = "20000000-0000-0000-0000-000000000003";
const T_OK = "30000000-0000-0000-0000-000000000001";
const T_PENDING = "30000000-0000-0000-0000-000000000002";
const E1 = "40000000-0000-0000-0000-000000000001";

async function fails(p: Promise<unknown> | (() => unknown), code: string, status?: number) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe(code);
    if (status) expect((e as ApiError).status).toBe(status);
    return e as ApiError;
  }
  throw new Error(`esperava ApiError ${code}`);
}

// ---- banco falso -----------------------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let calls: Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]>; or?: string }> = [];
let rpcs: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message: string } | null }> = {};
let seq = 0;

function fakeDb(): Db {
  return {
    rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(rpcs[name] ? { data: null, error: null, ...rpcs[name](args) } : { data: null, error: { code: "42883", message: "função inexistente" } }),
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      let op = "select";
      let payload: Row | Row[] | undefined;
      let head = false;
      let orFilter: string | undefined;
      let lim = Infinity;
      const b: Record<string, unknown> = {};
      b.select = (_c?: string, o?: { head?: boolean }) => ((head = Boolean(o?.head)), b);
      b.insert = (p: Row) => ((op = "insert"), (payload = p), b);
      b.update = (p: Row) => ((op = "update"), (payload = p), b);
      b.delete = () => ((op = "delete"), b);
      b.eq = (c: string, v: unknown) => (eqs.push([c, v]), b);
      b.in = (c: string, v: unknown[]) => (ins.push([c, v]), b);
      b.or = (s: string) => ((orFilter = s), b);
      b.order = () => b;
      b.limit = (n: number) => ((lim = n), b);
      b.then = (resolve: (v: unknown) => void) => {
        const match = (r: Row) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, v]) => v.includes(r[c]));
        calls.push({ table, op, payload, filters: eqs, or: orFilter });
        const rows = tables[table] ?? [];
        if (op === "insert") {
          const dup = (payload as Row).name && rows.some((r) => r.account_id === (payload as Row).account_id && String(r.name).toLowerCase() === String((payload as Row).name).toLowerCase());
          if (dup) return resolve({ data: null, error: { code: "23505", message: "dup" } });
          const row = { id: `${table}-${++seq}`, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z", ...(payload as Row) };
          (tables[table] ??= []).push(row);
          return resolve({ data: [row], error: null });
        }
        if (op === "update") {
          const hit = rows.filter(match);
          for (const r of hit) Object.assign(r, payload);
          return resolve({ data: hit.map((r) => ({ ...r })), error: null });
        }
        if (op === "delete") {
          tables[table] = rows.filter((r) => !match(r));
          return resolve({ data: null, error: null });
        }
        const found = rows.filter(match);
        resolve(head ? { data: null, count: found.length, error: null } : { data: found.slice(0, lim).map((r) => ({ ...r })), error: null });
      };
      return b;
    },
  } as unknown as Db;
}

const ruler = (over: Partial<RulerRow> = {}): Row => ({
  id: R1, account_id: A, name: "Padrão", active: false, dry_run: true, channel_id: CH_META, window_start: "08:00:00", window_end: "20:00:00",
  weekdays: [1, 2, 3, 4, 5], daily_cap_per_debtor: 1, tolerance_days: 1, pause_on_open_conversation: false, priority: 100, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...over,
});

beforeEach(() => {
  seq = 0;
  calls = [];
  rpcs = {};
  tables = {
    billing_rulers: [ruler()],
    billing_ruler_steps: [{ id: "S1", account_id: A, ruler_id: R1, position: 0, kind: "offset", offset_days: -3, active: true }],
    billing_enrollments: [],
    billing_step_sends: [],
    billing_debts: [],
    contacts: [],
    whatsapp_config: [
      { id: CH_META, account_id: A, provider: "meta" },
      { id: CH_WAHA, account_id: A, provider: "waha" },
      { id: CH_OTHER, account_id: B, provider: "meta" },
    ],
    message_templates: [
      { id: T_OK, account_id: A, status: "Approved", body_text: "Olá {{1}}, vence em {{2}}" },
      { id: T_PENDING, account_id: A, status: "Pending", body_text: "Oi" },
    ],
  };
});

// ---- validação pura --------------------------------------------------------------------------------------------------------------
describe("parseRulerInput", () => {
  it("cria só com name; a régua nasce desligada: active/dry_run no POST são recusados", () => {
    expect(parseRulerInput({ name: "  Padrão  " }, "create")).toEqual({ name: "Padrão" });
    expect(() => parseRulerInput({ name: "x", active: true }, "create")).toThrow(/nasce desligada/);
    expect(() => parseRulerInput({ name: "x", dry_run: false }, "create")).toThrow(/nasce desligada/);
    expect(() => parseRulerInput({}, "create")).toThrow(/name/);
  });

  it("campos e faixas (janela HH:MM, dias, teto 1–10, tolerância 0–30) e campo desconhecido", () => {
    expect(parseRulerInput({ window_start: "09:00", window_end: "18:30", weekdays: [5, 1, 3], daily_cap_per_debtor: 2, tolerance_days: 0, priority: 5, pause_on_open_conversation: true }, "patch")).toEqual({
      window_start: "09:00", window_end: "18:30", weekdays: [1, 3, 5], daily_cap_per_debtor: 2, tolerance_days: 0, priority: 5, pause_on_open_conversation: true,
    });
    for (const bad of [{ window_start: "9:00" }, { window_start: "25:00" }, { window_start: "18:00", window_end: "09:00" }, { weekdays: [] }, { weekdays: [1, 1] }, { weekdays: [7] }, { daily_cap_per_debtor: 0 }, { daily_cap_per_debtor: 11 }, { tolerance_days: 31 }, { channel_id: "x" }, { active: "sim" }, { id: "x" }, {}]) {
      expect(() => parseRulerInput(bad as Record<string, unknown>, "patch"), JSON.stringify(bad)).toThrow();
    }
    expect(parseRulerInput({ channel_id: null }, "patch")).toEqual({ channel_id: null });
  });
});

describe("parseStepsInput", () => {
  const ok = { kind: "offset", offset_days: -3, template_id: T_OK, variable_map: [{ type: "contact_field", field: "name" }, { type: "debt_field", field: "due_date" }] };

  it("aceita etapa por deslocamento e por status; posição vem da ordem; active padrão true", () => {
    const out = parseStepsInput({ steps: [ok, { kind: "status", status_trigger: "em_atraso", message_text: "Oi {{1}}", variable_map: [{ type: "static", value: "x" }] }] });
    expect(out[0]).toMatchObject({ kind: "offset", offset_days: -3, status_trigger: null, active: true });
    expect(out[1]).toMatchObject({ kind: "status", offset_days: null, status_trigger: "em_atraso" });
  });

  it("recusa: deslocamento repetido, kind inválido, offset fora da faixa, CPF/campo fora da lista no variable_map, mais de 30 etapas, id repetido", () => {
    expect(() => parseStepsInput({ steps: [ok, { ...ok }] })).toThrow(/repetido/);
    expect(() => parseStepsInput({ steps: [{ kind: "x" }] })).toThrow(/kind/);
    expect(() => parseStepsInput({ steps: [{ kind: "offset", offset_days: 400 }] })).toThrow(/offset_days/);
    expect(() => parseStepsInput({ steps: [{ ...ok, variable_map: [{ type: "contact_field", field: "cpf" }] }] })).toThrow(/variable_map/);
    expect(() => parseStepsInput({ steps: [{ ...ok, variable_map: Array.from({ length: 11 }, () => ({ type: "static", value: "a" })) }] })).toThrow(/até 10/);
    expect(() => parseStepsInput({ steps: Array.from({ length: 31 }, (_, i) => ({ kind: "offset", offset_days: i })) })).toThrow(/No máximo 30/);
    const id = "50000000-0000-0000-0000-000000000001";
    expect(() => parseStepsInput({ steps: [{ ...ok, id }, { kind: "offset", offset_days: 1, id }] })).toThrow(/id repetido/);
    expect(() => parseStepsInput({ steps: "x" })).toThrow(/lista/);
    expect(() => parseStepsInput({ steps: [{ ...ok, extra: 1 }] })).toThrow(/desconhecido/);
  });
});

describe("checkStepsAgainstChannel (Meta × WAHA bifurcado, só validado)", () => {
  const templates = new Map([
    [T_OK, { id: T_OK, status: "Approved", body_text: "Olá {{1}}, vence em {{2}}" }],
    [T_PENDING, { id: T_PENDING, status: "Pending", body_text: "Oi" }],
  ]);
  const step = (over: Partial<StepInput>): StepInput => ({ kind: "offset", offset_days: -1, status_trigger: null, template_id: null, message_text: null, variable_map: [], conditions: {}, active: true, ...over });
  const map2 = [{ type: "static", value: "a" }, { type: "static", value: "b" }] as StepInput["variable_map"];

  it("Meta: exige template aprovado, existente na conta e {{n}} do corpo cobertos", () => {
    expect(checkStepsAgainstChannel([step({ template_id: T_OK, variable_map: map2 })], "meta", templates)).toEqual([]);
    expect(checkStepsAgainstChannel([step({ message_text: "oi" })], "meta", templates)[0]).toMatch(/exige template/);
    expect(checkStepsAgainstChannel([step({ template_id: T_PENDING })], "meta", templates)[0]).toMatch(/aprovado/);
    expect(checkStepsAgainstChannel([step({ template_id: "30000000-0000-0000-0000-0000000000ff" })], "meta", templates)[0]).toMatch(/não encontrado/);
    expect(checkStepsAgainstChannel([step({ template_id: T_OK, variable_map: map2.slice(0, 1) })], "meta", templates)[0]).toMatch(/\{\{2\}\}/);
  });

  it("WAHA: exige texto com {{n}} cobertos; etapa inativa não é validada", () => {
    expect(checkStepsAgainstChannel([step({ message_text: "Olá {{1}}", variable_map: map2.slice(0, 1) })], "waha", templates)).toEqual([]);
    expect(checkStepsAgainstChannel([step({ template_id: T_OK })], "waha", templates)[0]).toMatch(/exige message_text/);
    expect(checkStepsAgainstChannel([step({ message_text: "Olá {{3}}", variable_map: map2 })], "waha", templates)[0]).toMatch(/\{\{3\}\}/);
    expect(checkStepsAgainstChannel([step({ active: false })], "waha", templates)).toEqual([]);
  });

  it("sem canal: aceita template ou texto; sem nenhum dos dois é problema", () => {
    expect(checkStepsAgainstChannel([step({ template_id: T_OK, variable_map: map2 })], null, templates)).toEqual([]);
    expect(checkStepsAgainstChannel([step({ message_text: "oi" })], null, templates)).toEqual([]);
    expect(checkStepsAgainstChannel([step({})], null, templates)).toHaveLength(1);
    expect(maxPlaceholder("{{1}} {{12}} {{x}}")).toBe(12);
  });
});

describe("data, motivo e cursor", () => {
  it("parseCivilDate rejeita data impossível; parseReason limita 200 e só aceita 'motivo'", () => {
    expect(parseCivilDate("2026-10-19")).toBe("2026-10-19");
    expect(() => parseCivilDate("2026-02-30")).toThrow(/válida/);
    expect(() => parseCivilDate("19/10/2026")).toThrow(/AAAA-MM-DD/);
    expect(() => parseCivilDate(undefined)).toThrow();
    expect(parseReason({ motivo: "  cliente pediu  " })).toBe("cliente pediu");
    expect(parseReason({})).toBeNull();
    expect(() => parseReason({ motivo: "x".repeat(201) })).toThrow();
    expect(() => parseReason({ outro: 1 })).toThrow(/desconhecido/);
  });

  it("cursor: ida e volta; lixo vira 400", () => {
    const c = encodeCursor({ created_at: "2026-10-19T10:00:00Z", id: E1 });
    expect(decodeCursor(c)).toEqual({ created_at: "2026-10-19T10:00:00Z", id: E1 });
    expect(decodeCursor(null)).toBeNull();
    expect(() => decodeCursor("lixo")).toThrow(/cursor/);
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ c: "x", i: "y" })).toString("base64url"))).toThrow(/cursor/);
  });
});

// ---- dados ----------------------------------------------------------------------------------------------------------------------
describe("createRuler / updateRuler / deleteRuler", () => {
  it("cria SEMPRE desligada e em dry-run, escopo na conta; canal de outra conta é recusado; nome repetido = 409", async () => {
    const created = await createRuler(fakeDb(), A, { name: "Nova", channel_id: CH_WAHA });
    expect(created).toMatchObject({ active: false, dry_run: true, account_id: A, channel_id: CH_WAHA });
    await fails(createRuler(fakeDb(), A, { name: "x", channel_id: CH_OTHER }), "bad_request", 400);
    await fails(createRuler(fakeDb(), A, { name: "nova" }), "conflict", 409);
  });

  it("ligar exige canal e ao menos uma etapa ativa; régua de outra conta = 404", async () => {
    tables.billing_rulers[0].channel_id = null;
    await fails(updateRuler(fakeDb(), A, R1, { active: true }), "conflict");
    tables.billing_rulers[0].channel_id = CH_META;
    tables.billing_ruler_steps[0].active = false;
    await fails(updateRuler(fakeDb(), A, R1, { active: true }), "conflict");
    tables.billing_ruler_steps[0].active = true;
    const { ruler: r, changed } = await updateRuler(fakeDb(), A, R1, { active: true });
    expect(r.active).toBe(true);
    expect(changed).toEqual(["active"]);
    await fails(updateRuler(fakeDb(), B, R1, { name: "x" }), "not_found", 404);
  });

  it("sair do dry-run com a régua ligada também passa pela regra de 'pode ligar'; mudar nada não grava", async () => {
    tables.billing_rulers[0].active = true;
    tables.billing_ruler_steps[0].active = false;
    await fails(updateRuler(fakeDb(), A, R1, { dry_run: false }), "conflict");
    tables.billing_ruler_steps[0].active = true;
    calls = [];
    const same = await updateRuler(fakeDb(), A, R1, { priority: 100 });
    expect(same.changed).toEqual([]);
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("desligar sempre pode; apagar só régua desligada e sem inscrições", async () => {
    tables.billing_rulers[0].active = true;
    const off = await updateRuler(fakeDb(), A, R1, { active: false });
    expect(off.ruler.active).toBe(false);
    tables.billing_rulers[0].active = true;
    await fails(deleteRuler(fakeDb(), A, R1), "conflict");
    tables.billing_rulers[0].active = false;
    tables.billing_enrollments.push({ id: E1, account_id: A, ruler_id: R1, status: "stopped" });
    await fails(deleteRuler(fakeDb(), A, R1), "conflict");
    tables.billing_enrollments = [];
    await deleteRuler(fakeDb(), A, R1);
    expect(tables.billing_rulers).toHaveLength(0);
  });
});

describe("replaceSteps", () => {
  const stepsOk = (): StepInput[] => [{ kind: "offset", offset_days: -3, status_trigger: null, template_id: T_OK, message_text: null, variable_map: [{ type: "contact_field", field: "name" }, { type: "debt_field", field: "due_date" }], conditions: {}, active: true }];
  const rulerRow = () => tables.billing_rulers[0] as unknown as RulerRow;

  it("canal Meta com template pendente: 400 com a lista de problemas e nada vai ao banco", async () => {
    const steps = stepsOk();
    steps[0].template_id = T_PENDING;
    const e = await fails(replaceSteps(fakeDb(), A, rulerRow(), steps), "bad_request", 400);
    expect(JSON.stringify(e.extra)).toMatch(/aprovado/);
  });

  it("válido: chama a RPC atômica com a conta da sessão e devolve as etapas salvas", async () => {
    const rpc = vi.fn(() => ({ data: 1, error: null }));
    rpcs.billing_replace_steps = rpc;
    const out = await replaceSteps(fakeDb(), A, rulerRow(), stepsOk());
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ p_account: A, p_ruler: R1 }));
    expect(out).toHaveLength(1);
  });

  it("etapa com histórico ⇒ 409; régua ligada sem etapa ativa ⇒ 409; RPC ausente ⇒ 503", async () => {
    rpcs.billing_replace_steps = () => ({ error: { message: "step_has_history" } });
    await fails(replaceSteps(fakeDb(), A, rulerRow(), stepsOk()), "conflict", 409);
    rpcs.billing_replace_steps = () => ({ error: { code: "23505", message: "dup" } });
    await fails(replaceSteps(fakeDb(), A, rulerRow(), stepsOk()), "conflict", 409);
    await fails(replaceSteps(fakeDb(), A, { ...rulerRow(), active: true }, []), "conflict", 409);
    delete rpcs.billing_replace_steps;
    await fails(replaceSteps(fakeDb(), A, rulerRow(), stepsOk()), "unavailable", 503);
  });
});

describe("dryRun e métricas", () => {
  it("dry-run devolve contagem por etapa ativa (zero quando não há) sem tocar em fila/envios", async () => {
    rpcs.billing_dry_run = () => ({ data: [{ step_id: "S1", offset_days: -3, debts: "7" }] });
    const out = await dryRun(fakeDb(), A, R1, "2026-10-22");
    expect(out).toMatchObject({ date: "2026-10-22", total: 7, steps: [{ step_id: "S1", offset_days: -3, debts: 7 }] });
    expect(calls.filter((c) => c.op !== "select")).toEqual([]);
    await fails(dryRun(fakeDb(), B, R1, "2026-10-22"), "not_found", 404);
  });

  it("métricas: soma por etapa e status, inscrições por motivo; régua de outra conta = 404", async () => {
    rpcs.billing_ruler_metrics = () => ({
      data: { steps: [{ step_id: "S1", status: "sent", total: 5 }, { step_id: "S1", status: "delivered", total: "3" }], enrollments: [{ status: "stopped", stop_reason: "paid", total: 2 }] },
    });
    const out = await rulerMetrics(fakeDb(), A, R1);
    expect(out.steps).toEqual([{ step_id: "S1", position: 0, offset_days: -3, active: true, total: 8, by_status: { sent: 5, delivered: 3 } }]);
    expect(out.enrollments).toEqual([{ status: "stopped", stop_reason: "paid", total: 2 }]);
    await fails(rulerMetrics(fakeDb(), B, R1), "not_found", 404);
  });
});

describe("enrollments", () => {
  const enr = (n: number, over: Row = {}): Row => ({ id: `40000000-0000-0000-0000-00000000000${n}`, account_id: A, ruler_id: R1, debt_id: `D${n}`, status: "active", stop_reason: null, stopped_at: null, next_step_at: null, created_at: `2026-10-0${n}T10:00:00Z`, ...over });

  it("lista: página com +1 gera next_cursor; devolve só o nome do contato (sem telefone/CPF); filtros inválidos = 400", async () => {
    tables.billing_enrollments = [enr(1), enr(2), enr(3)];
    tables.billing_debts = [1, 2, 3].map((n) => ({ id: `D${n}`, account_id: A, contact_id: `C${n}`, due_date: "2026-10-22", amount_cents: 15000, status: "open", external_ref: `ref${n}` }));
    tables.contacts = [1, 2, 3].map((n) => ({ id: `C${n}`, account_id: A, name: `Pessoa ${n}`, phone: "5521999990001", cpf: "12345678900" }));
    const page = await listEnrollments(fakeDb(), A, { limit: 2 });
    expect(page.enrollments).toHaveLength(2);
    expect(page.next_cursor).toEqual(expect.any(String));
    expect(page.enrollments[0].contact).toEqual({ id: "C1", name: "Pessoa 1" });
    expect(JSON.stringify(page)).not.toMatch(/5521999990001|12345678900|phone|cpf/);
    const next = await listEnrollments(fakeDb(), A, { limit: 2, cursor: page.next_cursor });
    expect(calls.find((c) => c.or)?.or).toMatch(/created_at\.lt\./);
    expect(next.enrollments.length).toBeGreaterThan(0);
    await fails(listEnrollments(fakeDb(), A, { status: "x" }), "bad_request");
    await fails(listEnrollments(fakeDb(), A, { motivo: "x" }), "bad_request");
    await fails(listEnrollments(fakeDb(), A, { cursor: "lixo" }), "bad_request");
  });

  it("outra conta não enxerga as inscrições", async () => {
    tables.billing_enrollments = [enr(1)];
    expect((await listEnrollments(fakeDb(), B, {})).enrollments).toEqual([]);
  });

  it("pausar → retomar → parar; repetir a ação (ou agir fora do estado) = 409; inexistente/outra conta = 404", async () => {
    tables.billing_enrollments = [enr(1, { next_step_at: "2026-10-20T00:00:00Z" })];
    const id = tables.billing_enrollments[0].id as string;
    expect((await controlEnrollment(fakeDb(), A, id, "pause")).enrollment.status).toBe("paused");
    await fails(controlEnrollment(fakeDb(), A, id, "pause"), "conflict", 409);
    expect((await controlEnrollment(fakeDb(), A, id, "resume")).enrollment.status).toBe("active");
    await fails(controlEnrollment(fakeDb(), A, id, "resume"), "conflict", 409);
    await fails(controlEnrollment(fakeDb(), B, id, "pause"), "not_found", 404);
    await fails(controlEnrollment(fakeDb(), A, "40000000-0000-0000-0000-0000000000ff", "stop"), "not_found", 404);
  });

  it("parar: motivo 'manual', zera next_step_at e cancela só os envios ainda não saídos (reservada/enfileirada)", async () => {
    tables.billing_enrollments = [enr(1, { next_step_at: "2026-10-20T00:00:00Z" })];
    const id = tables.billing_enrollments[0].id as string;
    tables.billing_step_sends = [
      { id: "X1", account_id: A, enrollment_id: id, status: "reserved" },
      { id: "X2", account_id: A, enrollment_id: id, status: "enqueued" },
      { id: "X3", account_id: A, enrollment_id: id, status: "sent" },
    ];
    const out = await controlEnrollment(fakeDb(), A, id, "stop");
    expect(out.cancelled_sends).toBe(2);
    expect(tables.billing_enrollments[0]).toMatchObject({ status: "stopped", stop_reason: "manual", next_step_at: null });
    expect(tables.billing_enrollments[0].stopped_at).toBeTruthy();
    expect(tables.billing_step_sends.map((s) => s.status)).toEqual(["cancelled", "cancelled", "sent"]);
    await fails(controlEnrollment(fakeDb(), A, id, "stop"), "conflict", 409);
  });
});
