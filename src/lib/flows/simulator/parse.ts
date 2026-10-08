import { can, type PermissionSubject } from "@/lib/auth/permissions";
import {
  SIM_STATE_TABLES,
  type SimDraftNode,
  type SimInboundMessage,
  type SimState,
  type SimulateRequest,
} from "./types";

/** Corpo máximo aceito pela rota (estado da simulação incluso). */
export const SIM_MAX_BODY_CHARS = 2_000_000;
const MAX_NODES = 500;
const MAX_TEXT = 4000;
const MAX_MOCK = 50_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stringRecord(v: unknown, maxLen: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val.slice(0, maxLen);
  }
  return out;
}

function parseState(v: unknown): SimState | null {
  if (!isObject(v) || v.version !== 1 || !isObject(v.tables)) return null;
  const tables: SimState["tables"] = {};
  for (const name of SIM_STATE_TABLES) {
    const rows = v.tables[name];
    if (Array.isArray(rows)) tables[name] = rows.filter(isObject);
  }
  return {
    version: 1,
    tables,
    clock: typeof v.clock === "number" && Number.isFinite(v.clock) ? v.clock : 0,
    seq: typeof v.seq === "number" && Number.isFinite(v.seq) ? v.seq : 0,
  };
}

function parseMessage(v: unknown): SimInboundMessage | null {
  if (!isObject(v)) return null;
  if (v.kind === "interactive_reply" && typeof v.reply_id === "string" && v.reply_id) {
    return {
      kind: "interactive_reply",
      reply_id: v.reply_id.slice(0, 256),
      reply_title: typeof v.reply_title === "string" ? v.reply_title.slice(0, 256) : v.reply_id,
    };
  }
  if (v.kind === "text" && typeof v.text === "string" && v.text.trim()) {
    return { kind: "text", text: v.text.slice(0, MAX_TEXT) };
  }
  return null;
}

/** Valida o corpo de POST /api/flows/[id]/simulate. String = mensagem de erro (pt-BR). */
export function parseSimulateRequest(raw: unknown): SimulateRequest | string {
  if (!isObject(raw)) return "Corpo inválido";
  const draft = raw.draft;
  if (!isObject(draft) || !Array.isArray(draft.nodes)) return "Rascunho do fluxo ausente";
  if (draft.nodes.length > MAX_NODES) return "Fluxo grande demais para simular";
  const nodes: SimDraftNode[] = [];
  for (const n of draft.nodes) {
    if (!isObject(n) || typeof n.node_key !== "string" || typeof n.node_type !== "string" || !isObject(n.config)) {
      return "Nó inválido no rascunho";
    }
    nodes.push({ node_key: n.node_key, node_type: n.node_type, config: n.config });
  }
  const message = parseMessage(raw.message);
  if (!message) return "Mensagem vazia";
  const contact = isObject(raw.contact) ? raw.contact : {};
  return {
    draft: {
      entry_node_id: typeof draft.entry_node_id === "string" ? draft.entry_node_id : null,
      trigger_type: typeof draft.trigger_type === "string" ? draft.trigger_type : "manual",
      trigger_config: isObject(draft.trigger_config) ? draft.trigger_config : {},
      fallback_policy: isObject(draft.fallback_policy) ? draft.fallback_policy : null,
      nodes,
    },
    message,
    state: parseState(raw.state),
    contact: {
      name: typeof contact.name === "string" && contact.name.trim() ? contact.name.slice(0, 120) : "Cliente Teste",
      phone: typeof contact.phone === "string" && contact.phone.trim() ? contact.phone.slice(0, 32) : "5500000000000",
      vars: stringRecord(contact.vars, 2000),
    },
    provider: raw.provider === "waha" ? "waha" : "meta",
    ignoreTrigger: raw.ignoreTrigger !== false,
    toolMocks: stringRecord(raw.toolMocks, MAX_MOCK),
    realReadOnlyTools: Array.isArray(raw.realReadOnlyTools)
      ? raw.realReadOnlyTools.filter((t): t is string => typeof t === "string")
      : [],
    httpMocks: stringRecord(raw.httpMocks, MAX_MOCK),
  };
}

/**
 * Leitura REAL com credencial no simulador: exige `secrets.write` (admin/owner hoje). Supervisor simula
 * normalmente (`flows.simulate`), mas qualquer pedido de leitura real é descartado (tudo mockado).
 */
export function applyRealReadPolicy<T extends { realReadOnlyTools: string[] }>(
  subject: PermissionSubject,
  req: T,
): { request: T; denied: boolean } {
  if (can(subject, "secrets.write")) return { request: req, denied: false };
  return { request: { ...req, realReadOnlyTools: [] }, denied: req.realReadOnlyTools.length > 0 };
}
