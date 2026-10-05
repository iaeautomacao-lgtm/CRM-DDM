// Filtros do inbox (F2): mesmos nomes na URL (?canal=&linha=...), na rota
// /api/inbox/conversations e no filtro local usado para encaixar conversas
// que chegam pelo tempo real. Puro — testável e usado no cliente e no servidor.

import type { Conversation } from "@/types";

export const INBOX_CHANNELS = ["whatsapp", "webchat", "instagram", "messenger"] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];

export type InboxStatus = "active" | "open" | "pending" | "closed" | "unread";

export interface InboxFilters {
  canal: InboxChannel | null;
  /** Linha: whatsapp_config.id ou channels.id (ver /api/lines). */
  linha: string | null;
  /** "me" | "unassigned" | id do atendente. */
  atendente: string | null;
  equipe: string | null;
  cliente: string | null;
  campanha: string | null;
  status: InboxStatus;
  q: string;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  canal: null,
  linha: null,
  atendente: null,
  equipe: null,
  cliente: null,
  campanha: null,
  status: "active",
  q: "",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly InboxStatus[] = ["active", "open", "pending", "closed", "unread"];

function uuidOrNull(v: string | null): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

/** Lê e valida os filtros da query string (valores inválidos são ignorados). */
export function parseInboxFilters(params: URLSearchParams): InboxFilters {
  const canal = params.get("canal");
  const atendente = params.get("atendente");
  const status = params.get("status") as InboxStatus | null;
  return {
    canal: canal && (INBOX_CHANNELS as readonly string[]).includes(canal) ? (canal as InboxChannel) : null,
    linha: uuidOrNull(params.get("linha")),
    atendente: atendente === "me" || atendente === "unassigned" ? atendente : uuidOrNull(atendente),
    equipe: uuidOrNull(params.get("equipe")),
    cliente: uuidOrNull(params.get("cliente")),
    campanha: uuidOrNull(params.get("campanha")),
    status: status && STATUSES.includes(status) ? status : "active",
    q: (params.get("q") ?? "").slice(0, 80),
  };
}

/** Grava só o que difere do padrão, preservando outros parâmetros (?c=). */
export function writeInboxFilters(base: URLSearchParams, f: InboxFilters): URLSearchParams {
  const next = new URLSearchParams(base);
  const entries: Array<[keyof InboxFilters, string | null]> = [
    ["canal", f.canal],
    ["linha", f.linha],
    ["atendente", f.atendente],
    ["equipe", f.equipe],
    ["cliente", f.cliente],
    ["campanha", f.campanha],
    ["status", f.status === "active" ? null : f.status],
    ["q", f.q.trim() || null],
  ];
  for (const [key, value] of entries) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

/** Busca segura para o filtro PostgREST .or(): sem vírgula/parênteses/curingas. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[,()%*\\]/g, " ").trim();
}

export interface LineRef {
  id: string;
  channel_type: string;
  waha_session: string | null;
}

/**
 * Mesmo critério da rota, aplicado a uma conversa que chegou pelo tempo
 * real: decide se ela entra na lista que está aberta com estes filtros.
 * (A busca por texto fica de fora: o servidor resolve na próxima carga.)
 */
export function conversationMatchesFilters(
  c: Conversation,
  f: InboxFilters,
  ctx: { userId: string | null; line: LineRef | null },
): boolean {
  const channel = c.channel_type ?? "whatsapp";
  if (f.canal && channel !== f.canal) return false;
  if (f.linha && ctx.line) {
    const byConfig = c.config_id === ctx.line.id || c.channel_id === ctx.line.id;
    const byLegacySession = !!ctx.line.waha_session && c.waha_session === ctx.line.waha_session;
    if (!byConfig && !byLegacySession) return false;
  }
  if (f.atendente === "me" && c.assigned_agent_id !== ctx.userId) return false;
  if (f.atendente === "unassigned" && c.assigned_agent_id) return false;
  if (f.atendente && f.atendente !== "me" && f.atendente !== "unassigned" && c.assigned_agent_id !== f.atendente) {
    return false;
  }
  if (f.equipe && c.team_id !== f.equipe) return false;
  if (f.cliente && c.client_id !== f.cliente) return false;
  if (f.campanha && c.origin_campaign_id !== f.campanha) return false;
  switch (f.status) {
    case "active":
      return c.status === "open" || c.status === "pending";
    case "unread":
      return c.unread_count > 0 && c.status !== "closed";
    default:
      return c.status === f.status;
  }
}
