// Revisão de fluxos (M1/M2/M3/M6): o cliente Supabase NÃO lança em erro de banco — devolve { error }. Estes testes provam que set_tag, add_note,
// updateRunVars, endRun e dispatchInboundToFlows agora CONFEREM o erro e deixam rastro, sem mudar o caminho do fluxo.
import { beforeEach, describe, expect, it, vi } from "vitest";

const writeLog = vi.hoisted(() => vi.fn());
const dbState = vi.hoisted(() => ({ throwOnFrom: false }));

vi.mock("@/lib/logger", () => ({ writeLog }));
vi.mock("@/lib/ai/responder", () => ({ handleAiAutoResponse: vi.fn(), AI_EMPTY_REPLY_FALLBACK_TEXT: "fallback" }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => {
    if (dbState.throwOnFrom) return { from: () => { throw new Error("banco fora do ar: segredo-123"); } };
    return { from: () => ({}) };
  },
}));

import { advanceFromNodeKey, dispatchInboundToFlows } from "./engine";
import type { FlowNodeRow, FlowRunRow } from "./types";

type Row = Record<string, unknown>;
let events: Row[] = [];
let runUpdates: Row[] = [];
let failures: { tables: Set<string>; runUpdate: boolean };

function fakeDb() {
  const from = (table: string) => {
    let op: "select" | "update" | "insert" | "upsert" | "delete" = "select";
    let payload: Row = {};
    let single = false;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["eq", "neq", "is", "in", "lt", "lte", "gt", "gte", "order", "limit", "range", "not", "or", "filter", "match", "contains"]) b[m] = chain;
    b.select = () => b;
    b.update = (p: Row) => ((op = "update"), (payload = p), b);
    b.insert = (p: Row) => ((op = "insert"), (payload = p), b);
    b.upsert = (p: Row) => ((op = "upsert"), (payload = p), b);
    b.delete = () => ((op = "delete"), b);
    b.maybeSingle = () => ((single = true), b);
    b.single = () => ((single = true), b);
    b.then = (resolve: (v: unknown) => void) => {
      if (table === "flow_run_events" && op === "insert") events.push(payload);
      if (table === "flow_runs" && op === "update") runUpdates.push(payload);
      if (op !== "select" && (failures.tables.has(table) || (table === "flow_runs" && op === "update" && failures.runUpdate))) {
        return resolve({ data: null, error: { message: `falha simulada em ${table}`, code: "XX000" } });
      }
      if (op === "update") return resolve({ data: [{ id: "r1" }], error: null });
      if (op !== "select") return resolve({ data: null, error: null });
      return resolve({ data: single ? null : [], error: null });
    };
    return b;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

const FLOW = "66a59213-a13f-4820-bd71-a1dd5967e646";
const node = (node_key: string, node_type: string, config: Row): FlowNodeRow =>
  ({ id: node_key, flow_id: FLOW, node_key, node_type, config, position_x: 0, position_y: 0 }) as unknown as FlowNodeRow;
const flow = (...nodes: FlowNodeRow[]) => new Map(nodes.map((n) => [n.node_key, n]));
const run = (): FlowRunRow =>
  ({
    id: "r1", flow_id: FLOW, account_id: "acc", user_id: "u", contact_id: "ct", conversation_id: "cv", status: "active", current_node_key: null,
    last_prompt_message_id: null, vars: { nome: "Maria" }, reprompt_count: 0, hops_count: 0, started_at: "2026-10-06T12:00:00Z",
    last_advanced_at: "2026-10-06T12:00:00Z", ended_at: null, end_reason: null,
  }) as unknown as FlowRunRow;

const eventTypes = (nodeKey: string) => events.filter((e) => e.node_key === nodeKey).map((e) => e.event_type);
const logged = (event: string) => writeLog.mock.calls.map((c) => c[0] as Row).filter((l) => l.event === event);

beforeEach(() => {
  writeLog.mockReset();
  events = [];
  runUpdates = [];
  failures = { tables: new Set(), runUpdate: false };
  dbState.throwOnFrom = false;
});

describe("M1 — set_tag e add_note conferem o { error } do banco", () => {
  const tagFlow = (mode: "add" | "remove") => flow(node("tag", "set_tag", { mode, tag_id: "t1", next_node_key: "fim" }), node("fim", "end", {}));
  const noteFlow = () => flow(node("nota", "add_note", { note_text: "Oi {{vars.nome}}", next_node_key: "fim" }), node("fim", "end", {}));

  it("set_tag (add e remove) com erro de banco: registra node_error, NÃO registra sucesso e o fluxo segue para o próximo nó como antes", async () => {
    for (const mode of ["add", "remove"] as const) {
      events = [];
      failures.tables = new Set(["contact_tags"]);
      const out = await advanceFromNodeKey(fakeDb() as never, run(), "tag", tagFlow(mode));
      expect(eventTypes("tag"), mode).toContain("node_error");
      expect(eventTypes("tag"), mode).not.toContain("node_completed");
      expect(events.some((e) => e.event_type === "error" || (e.payload as Row | undefined)?.reason === "set_tag_failed"), mode).toBe(true);
      expect(eventTypes("fim"), mode).toContain("node_completed"); // caminho do fluxo inalterado: segue e termina
      expect(out.outcome).toBe("completed");
    }
  });

  it("set_tag sem erro de banco: sucesso como sempre", async () => {
    await advanceFromNodeKey(fakeDb() as never, run(), "tag", tagFlow("add"));
    expect(eventTypes("tag")).toContain("node_completed");
    expect(eventTypes("tag")).not.toContain("node_error");
  });

  it("add_note com erro de banco: registra node_error e segue; sem erro: sucesso", async () => {
    failures.tables = new Set(["contact_notes"]);
    await advanceFromNodeKey(fakeDb() as never, run(), "nota", noteFlow());
    expect(eventTypes("nota")).toContain("node_error");
    expect(eventTypes("nota")).not.toContain("node_completed");
    expect(eventTypes("fim")).toContain("node_completed");
    events = [];
    failures.tables = new Set();
    await advanceFromNodeKey(fakeDb() as never, run(), "nota", noteFlow());
    expect(eventTypes("nota")).toContain("node_completed");
  });
});

describe("M2 — updateRunVars registra a falha de gravação (só as chaves)", () => {
  it("set_variable com erro ao gravar as variáveis: system_logs flow_vars_update_failed com a CHAVE, nunca o valor; o fluxo segue", async () => {
    failures.runUpdate = true;
    const nodes = flow(node("v", "set_variable", { assignments: [{ variable: "protocolo", value: "SEGREDO-999" }], next_node_key: "fim" }), node("fim", "end", {}));
    const r = run();
    await advanceFromNodeKey(fakeDb() as never, r, "v", nodes);
    const [log] = logged("flow_vars_update_failed");
    expect(log).toMatchObject({ account_id: "acc", level: "error", source: "flows", payload: { flow_run_id: "r1", keys: ["protocolo"], code: "XX000" } });
    expect(JSON.stringify(log)).not.toContain("SEGREDO-999");
    expect(r.vars.protocolo).toBeUndefined(); // a memória continua com o valor antigo, como antes
    expect(eventTypes("fim")).toContain("node_completed");
  });

  it("sem erro: grava e não registra nada", async () => {
    const nodes = flow(node("v", "set_variable", { assignments: [{ variable: "protocolo", value: "ok" }], next_node_key: "fim" }), node("fim", "end", {}));
    const r = run();
    await advanceFromNodeKey(fakeDb() as never, r, "v", nodes);
    expect(logged("flow_vars_update_failed")).toEqual([]);
    expect(r.vars.protocolo).toBe("ok");
  });
});

describe("M3 — endRun registra o UPDATE de status que falhou", () => {
  it("nó end com erro no UPDATE: system_logs flow_end_run_failed com o status pretendido; os eventos do run continuam sendo gravados", async () => {
    failures.runUpdate = true;
    await advanceFromNodeKey(fakeDb() as never, run(), "fim", flow(node("fim", "end", {})));
    const [log] = logged("flow_end_run_failed");
    expect(log).toMatchObject({ account_id: "acc", level: "error", source: "flows", payload: { flow_run_id: "r1", intended_status: "completed", code: "XX000" } });
  });

  it("sem erro: nenhum registro de falha", async () => {
    await advanceFromNodeKey(fakeDb() as never, run(), "fim", flow(node("fim", "end", {})));
    expect(logged("flow_end_run_failed")).toEqual([]);
    expect(runUpdates.some((u) => u.status === "completed")).toBe(true);
  });
});

describe("M6 — dispatchInboundToFlows registra a exceção e MANTÉM consumed:false", () => {
  it("exceção ao despachar: system_logs flow_dispatch_error (mensagem curta, ids) e o retorno é o mesmo de sempre", async () => {
    dbState.throwOnFrom = true;
    const out = await dispatchInboundToFlows({
      accountId: "acc", contactId: "ct", conversationId: "cv", message: { kind: "text", text: "oi", messageId: "wamid.1" } as never, isFirstInboundMessage: true,
    } as never);
    expect(out).toEqual({ consumed: false, outcome: "no_match" }); // inalterado: quem responde ao cliente não muda
    const [log] = logged("flow_dispatch_error");
    expect(log).toMatchObject({ account_id: "acc", level: "error", source: "flows", payload: { contact_id: "ct", conversation_id: "cv" } });
    expect(String((log.payload as Row).detail)).toContain("banco fora do ar");
  });
});
