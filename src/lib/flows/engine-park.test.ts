// PRD 01, seção 6 (e): #RECUSA → a recuperação só roda na mensagem
// seguinte. Roda o walk real do engine (advanceFromNodeKey) com o fluxo
// agente_ddm → switch_resultado → recovery_recusa (migration 138), banco
// simulado e o responder (handleAiAutoResponse) simulado — o que importa
// aqui é QUANTAS vezes a IA é chamada para a mesma mensagem do cliente e
// onde o run fica estacionado.

import { beforeEach, describe, expect, it, vi } from "vitest";

const handleAiAutoResponse = vi.fn();
vi.mock("@/lib/ai/responder", () => ({
  handleAiAutoResponse: (...args: unknown[]) => handleAiAutoResponse(...args),
  AI_EMPTY_REPLY_FALLBACK_TEXT: "fallback",
}));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));
const suggestOutcome = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/outcome-suggestion", () => ({ suggestOutcomeFromAiDecision: suggestOutcome }));

import { advanceFromNodeKey } from "./engine";
import type { FlowNodeRow, FlowRunRow } from "./types";

type Row = Record<string, unknown>;

/** Banco permissivo: toda leitura vem vazia; grava os UPDATEs de flow_runs. */
function fakeDb() {
  const runUpdates: Row[] = [];
  const from = (table: string) => {
    let op: "select" | "update" | "insert" | "upsert" | "delete" = "select";
    let payload: Row = {};
    let single = false;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["eq", "neq", "is", "in", "lt", "lte", "gt", "gte", "order", "limit", "range", "not", "or", "filter", "match", "contains"]) {
      b[m] = chain;
    }
    b.select = () => b;
    b.update = (p: Row) => { op = "update"; payload = p; return b; };
    b.insert = (p: Row) => { op = "insert"; payload = p; return b; };
    b.upsert = (p: Row) => { op = "upsert"; payload = p; return b; };
    b.delete = () => { op = "delete"; return b; };
    b.maybeSingle = () => { single = true; return b; };
    b.single = () => { single = true; return b; };
    b.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      try {
        if (table === "flow_runs" && op === "update") runUpdates.push(payload);
        if (op === "update") return resolve({ data: [{ id: "r1" }], error: null });
        if (op !== "select") return resolve({ data: null, error: null });
        return resolve({ data: single ? null : [], error: null });
      } catch (err) {
        reject?.(err);
      }
    };
    return b;
  };
  return { db: { from, rpc: async () => ({ data: null, error: null }) }, runUpdates };
}

const FLOW = "66a59213-a13f-4820-bd71-a1dd5967e646";
const node = (node_key: string, node_type: string, config: Row): FlowNodeRow =>
  ({ id: node_key, flow_id: FLOW, node_key, node_type, config, position_x: 0, position_y: 0 }) as unknown as FlowNodeRow;

const exitBranch = (id: string, tag: string, next: string) => ({
  id,
  label: tag,
  combinator: "and",
  conditions: [{ subject: "var", subject_key: "ai_exit_code", operator: "equals", value: tag }],
  next_node_key: next,
});

function recusaFlow(): Map<string, FlowNodeRow> {
  const nodes = [
    node("agente_ddm", "ai_agent", { mode: "loop", max_turns: 20, next_node_key: "switch_resultado" }),
    node("switch_resultado", "switch", {
      default_next: "fim",
      branches: [exitBranch("branch-recusa", "#RECUSA", "recovery_recusa"), exitBranch("branch-neg", "#NEGOCIACAO", "aleh")],
    }),
    node("recovery_recusa", "ai_agent", { mode: "loop", max_turns: 2, next_node_key: "fim" }),
    node("aleh", "ai_agent", { mode: "loop", max_turns: 20, next_node_key: "fim" }),
    node("fim", "end", {}),
  ];
  return new Map(nodes.map((n) => [n.node_key, n]));
}

function run(): FlowRunRow {
  return {
    id: "r1",
    flow_id: FLOW,
    account_id: "acc",
    user_id: "u",
    contact_id: "ct",
    conversation_id: "cv",
    status: "active",
    current_node_key: "agente_ddm",
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
    started_at: "2026-10-06T12:00:00Z",
    last_advanced_at: "2026-10-06T12:00:00Z",
    ended_at: null,
    end_reason: null,
  } as unknown as FlowRunRow;
}

const sent = (content: string, tag: string) => ({
  outcome: "sent",
  messageId: "msg-1",
  providerMessageId: null,
  content,
  detectedTag: tag,
  modelUsed: "gpt-4o-mini",
  forcedExit: null,
});

beforeEach(() => {
  handleAiAutoResponse.mockReset();
  suggestOutcome.mockReset();
});

describe("estacionar antes do próximo ai_agent (C3)", () => {
  it("decisão com tag repassa o mesmo db simulado para a sugestão", async () => {
    handleAiAutoResponse.mockResolvedValueOnce(sent("Encaminhando para a equipe.", "#RECUSA"));
    const { db } = fakeDb();
    await advanceFromNodeKey(db as never, run(), "agente_ddm", recusaFlow());
    // O gancho é best-effort e usa import dinâmico.
    await vi.waitFor(() => expect(suggestOutcome).toHaveBeenCalledWith(db, expect.objectContaining({
      account_id: "acc", conversation_id: "cv", ai_exit_code: "#RECUSA",
    })));
  });
  it("(e) #RECUSA com pergunta ao cliente: recovery_recusa NÃO roda na mesma mensagem", async () => {
    handleAiAutoResponse.mockResolvedValueOnce(
      sent("Entendo. Antes de encerrar, o que mais pesa para você hoje?", "#RECUSA"),
    );
    const { db, runUpdates } = fakeDb();
    const r = run();
    const out = await advanceFromNodeKey(db as never, r, "agente_ddm", recusaFlow());

    expect(out.outcome).toBe("advanced");
    // Só o agente principal respondeu à mensagem do cliente.
    expect(handleAiAutoResponse).toHaveBeenCalledTimes(1);
    // Run estacionado no nó de recuperação, esperando a próxima mensagem.
    expect(runUpdates.some((u) => u.current_node_key === "recovery_recusa")).toBe(true);
  });

  it("(e) mesma coisa quando o walk começa no switch (saída do nó estacionado)", async () => {
    const { db, runUpdates } = fakeDb();
    const r = run();
    r.vars = { ai_exit_code: "#RECUSA" };
    // É o que handleReplyForActiveRun passa depois que o agente_ddm
    // estacionado saiu com tag tendo respondido ao cliente.
    const out = await advanceFromNodeKey(db as never, r, "switch_resultado", recusaFlow(), undefined, {
      inboundAnsweredByAi: true,
    });
    expect(out.outcome).toBe("advanced");
    expect(handleAiAutoResponse).not.toHaveBeenCalled();
    expect(runUpdates.some((u) => u.current_node_key === "recovery_recusa")).toBe(true);
  });

  it("#RECUSA só com a tag (nada enviado ao cliente): recuperação roda na hora", async () => {
    handleAiAutoResponse
      .mockResolvedValueOnce({ outcome: "skipped", reason: "control_tag_only", detectedTag: "#RECUSA", modelUsed: null })
      .mockResolvedValueOnce(sent("O que mais pesa para você hoje?", ""));
    const { db } = fakeDb();
    await advanceFromNodeKey(db as never, run(), "agente_ddm", recusaFlow());
    expect(handleAiAutoResponse).toHaveBeenCalledTimes(2);
    // Argumento de índice 11 = nodeKey do nó executado.
    expect(handleAiAutoResponse.mock.calls[1][11]).toBe("recovery_recusa");
  });

  it("BEN → Aleh: #NEGOCIACAO sem texto ao cliente — o Aleh responde na mesma mensagem", async () => {
    handleAiAutoResponse
      .mockResolvedValueOnce({ outcome: "skipped", reason: "control_tag_only", detectedTag: "#NEGOCIACAO", modelUsed: null })
      .mockResolvedValueOnce(sent("Seu débito é R$ 100. Posso parcelar em 3x.", ""));
    const { db } = fakeDb();
    await advanceFromNodeKey(db as never, run(), "agente_ddm", recusaFlow());
    expect(handleAiAutoResponse).toHaveBeenCalledTimes(2);
    expect(handleAiAutoResponse.mock.calls[1][11]).toBe("aleh");
  });

  it("ai_agent alcançado a partir do trigger responde a primeira mensagem", async () => {
    handleAiAutoResponse.mockResolvedValueOnce(sent("Olá! Como posso ajudar?", ""));
    const { db, runUpdates } = fakeDb();
    const r = run();
    r.current_node_key = null;
    await advanceFromNodeKey(db as never, r, "agente_ddm", recusaFlow());
    expect(handleAiAutoResponse).toHaveBeenCalledTimes(1);
    expect(runUpdates.some((u) => u.current_node_key === "agente_ddm")).toBe(true);
  });
});
