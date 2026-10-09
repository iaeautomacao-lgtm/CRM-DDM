// PRD 21.4 — nó send_flow no walk real do engine: token fr:<run>, bifurcação de canal e falha de envio.
// Banco simulado permissivo (como engine-park.test.ts); os envios (Meta/WAHA/canais) são simulados.
import { beforeEach, describe, expect, it, vi } from "vitest";

const engineSendFlow = vi.hoisted(() => vi.fn());
const channel = vi.hoisted(() => ({ value: "whatsapp" }));

vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));
vi.mock("@/lib/ai/responder", () => ({ handleAiAutoResponse: vi.fn(), AI_EMPTY_REPLY_FALLBACK_TEXT: "fallback" }));
vi.mock("@/lib/flows/meta-send", () => ({
  engineSendFlow: (...a: unknown[]) => engineSendFlow(...a),
  engineSendText: vi.fn(),
  engineSendMedia: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
  engineSendCtaUrl: vi.fn(),
  engineMetaSendTemplate: vi.fn(),
}));
vi.mock("@/lib/webchat/send", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConversationChannel: async () => channel.value,
}));

import { advanceFromNodeKey } from "./engine";
import type { FlowNodeRow, FlowRunRow } from "./types";

type Row = Record<string, unknown>;

function fakeDb() {
  const runUpdates: Row[] = [];
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
      if (table === "flow_runs" && op === "update") runUpdates.push(payload);
      if (op === "update") return resolve({ data: [{ id: "r1" }], error: null });
      if (op !== "select") return resolve({ data: null, error: null });
      return resolve({ data: single ? null : [], error: null });
    };
    return b;
  };
  return { db: { from, rpc: async () => ({ data: null, error: null }) }, runUpdates };
}

const FLOW = "66a59213-a13f-4820-bd71-a1dd5967e646";
const node = (node_key: string, node_type: string, config: Row): FlowNodeRow =>
  ({ id: node_key, flow_id: FLOW, node_key, node_type, config, position_x: 0, position_y: 0 }) as unknown as FlowNodeRow;

const flowCfg = (over: Row = {}) => ({
  flow_id: "495819284729182",
  cta_text: "Negociar",
  body_text: "Olá {{vars.nome}}, escolha seu acordo.",
  header_text: "Proposta",
  flow_action: "data_exchange",
  screen_id: "TELA_INICIAL",
  next_node_key: "fim",
  ...over,
});

const nodes = (cfg: Row) => new Map([node("form", "send_flow", cfg), node("fim", "end", {})].map((n) => [n.node_key, n]));

function run(): FlowRunRow {
  return {
    id: "r1", flow_id: FLOW, account_id: "acc", user_id: "u", contact_id: "ct", conversation_id: "cv", status: "active", current_node_key: null,
    last_prompt_message_id: null, vars: { nome: "Maria" }, reprompt_count: 0, started_at: "2026-10-06T12:00:00Z", last_advanced_at: "2026-10-06T12:00:00Z",
    ended_at: null, end_reason: null,
  } as unknown as FlowRunRow;
}

beforeEach(() => {
  engineSendFlow.mockReset();
  engineSendFlow.mockResolvedValue({ whatsapp_message_id: "wamid.1" });
  channel.value = "whatsapp";
});

describe("nó send_flow no engine", () => {
  it("canal Meta: envia o convite com o token fr:<run>, texto com {{vars}} interpolado, e guarda a tela inicial do Data Exchange no run", async () => {
    const { db, runUpdates } = fakeDb();
    await advanceFromNodeKey(db as never, run(), "form", nodes(flowCfg()));
    expect(engineSendFlow).toHaveBeenCalledTimes(1);
    expect(engineSendFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc", contactId: "ct", conversationId: "cv", flowId: "495819284729182", ctaText: "Negociar", flowAction: "data_exchange",
        flowToken: "fr:r1", bodyText: "Olá Maria, escolha seu acordo.", headerText: "Proposta", screenId: "TELA_INICIAL",
      }),
    );
    expect(runUpdates.some((u) => (u.vars as Row | undefined)?._flow_screen === "TELA_INICIAL")).toBe(true);
  });

  it("depois de enviar o convite o run segue para o próximo nó (a resposta do formulário chega como variáveis, sem efetivar nada)", async () => {
    const { db, runUpdates } = fakeDb();
    await advanceFromNodeKey(db as never, run(), "form", nodes(flowCfg({ flow_action: "navigate" })));
    expect(runUpdates.some((u) => u.status === "completed")).toBe(true);
    expect(runUpdates.some((u) => u.status === "failed")).toBe(false);
  });

  it("falha na Meta encerra o run como failed (send_flow_failed) em vez de seguir como se tivesse enviado", async () => {
    engineSendFlow.mockRejectedValueOnce(new Error("Meta API error: 400"));
    const { db, runUpdates } = fakeDb();
    const out = await advanceFromNodeKey(db as never, run(), "form", nodes(flowCfg()));
    expect(out.outcome).toBe("completed");
    expect(runUpdates.some((u) => u.status === "failed" && u.end_reason === "send_flow_failed")).toBe(true);
  });

  it("canal que não é WhatsApp (Instagram, Webchat…): não manda Flow; sem fallback_text o nó só avança", async () => {
    channel.value = "instagram";
    const { db, runUpdates } = fakeDb();
    await advanceFromNodeKey(db as never, run(), "form", nodes(flowCfg()));
    expect(engineSendFlow).not.toHaveBeenCalled();
    expect(runUpdates.some((u) => u.status === "failed")).toBe(false);
  });
});
