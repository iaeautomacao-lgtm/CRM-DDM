import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboxFilters } from "./filters";

// Montagem da consulta do inbox (lista e contadores das abas). A parte
// assíncrona (descobrir se a "linha" é um número de WhatsApp ou uma conta
// de Instagram/Messenger) roda ANTES, em resolveLineClause; applyInboxFilters
// é síncrona porque o builder do PostgREST é "thenable" — devolvê-lo de uma
// função async executaria a consulta antes da hora.

export type LineClause =
  | { kind: "none" }
  | { kind: "config"; id: string; wahaSession: string | null }
  | { kind: "channel"; id: string };

export async function resolveLineClause(
  supabase: SupabaseClient,
  accountId: string,
  lineId: string | null,
): Promise<LineClause> {
  if (!lineId) return { kind: "none" };
  const { data } = await supabase
    .from("whatsapp_config")
    .select("id, waha_session")
    .eq("id", lineId)
    .eq("account_id", accountId)
    .limit(1);
  const line = data?.[0];
  return line
    ? { kind: "config", id: line.id, wahaSession: line.waha_session ?? null }
    : { kind: "channel", id: lineId };
}

/**
 * Filtros comuns à lista e aos contadores. Linha WAHA casa também por
 * waha_session (conversas antigas sem config_id); Instagram/Messenger
 * por channel_id.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- builder do PostgREST sem tipos gerados
export function applyInboxFilters<Q extends Record<string, any>>(
  query: Q,
  f: InboxFilters,
  ctx: { accountId: string; userId: string; line: LineClause },
  opts: { includeStatus: boolean },
): Q {
  let q = query.eq("account_id", ctx.accountId);
  // Conversas anteriores à migration 127 têm channel_type='whatsapp' (default).
  if (f.canal) q = q.eq("channel_type", f.canal);
  if (ctx.line.kind === "config") {
    q = ctx.line.wahaSession
      ? q.or(`config_id.eq.${ctx.line.id},waha_session.eq.${ctx.line.wahaSession}`)
      : q.eq("config_id", ctx.line.id);
  } else if (ctx.line.kind === "channel") {
    q = q.eq("channel_id", ctx.line.id);
  }
  if (f.atendente === "me") q = q.eq("assigned_agent_id", ctx.userId);
  else if (f.atendente === "unassigned") q = q.is("assigned_agent_id", null);
  else if (f.atendente) q = q.eq("assigned_agent_id", f.atendente);
  if (f.equipe) q = q.eq("team_id", f.equipe);
  if (f.cliente) q = q.eq("client_id", f.cliente);
  if (f.campanha) q = q.eq("origin_campaign_id", f.campanha);
  if (opts.includeStatus) {
    if (f.status === "active") q = q.in("status", ["open", "pending"]);
    else if (f.status === "unread") q = q.gt("unread_count", 0).neq("status", "closed");
    else q = q.eq("status", f.status);
  }
  return q;
}
