import type { SupabaseClient } from "@supabase/supabase-js";
import { simNow, type SimClock, type SimTables } from "./memory-db";
import type { SimOutbound, SimOutboundKind, SimTimelineEvent } from "./types";

/**
 * Contexto de UMA mensagem simulada. Tudo que o motor "faria lá fora"
 * vira registro aqui (mensagens capturadas, notas na linha do tempo).
 */
export interface SimContext {
  accountId: string;
  conversationId: string;
  provider: "meta" | "waha";
  db: SupabaseClient;
  tables: SimTables;
  clock: SimClock;
  outbound: SimOutbound[];
  notes: SimTimelineEvent[];
  toolMocks: Record<string, string>;
  realReadOnlyTools: string[];
  httpMocks: Record<string, string>;
  /**
   * fetch de verdade — usado só para tools somente-leitura que o usuário
   * liberou (ver effectiveSimToolMode). O provedor de IA usa o fetch do
   * próprio responder.
   */
  realFetch: typeof fetch;
  /** Contador de ids sintéticos (vai no estado). */
  seq: { value: number };
}

export function simNote(ctx: SimContext, label: string, nodeKey: string | null = null, detail?: unknown) {
  ctx.notes.push({ at: simNow(ctx.clock), type: "note", node_key: nodeKey, label, ...(detail !== undefined ? { detail } : {}) });
}

/** Grava a mensagem do bot na conversa simulada e devolve o id "do provedor". */
export function captureOutbound(
  ctx: SimContext,
  input: {
    kind: SimOutboundKind;
    text: string;
    source: "flow" | "ia";
    options?: Array<{ id: string; title: string }>;
    mediaUrl?: string | null;
  },
): { whatsapp_message_id: string; id: string } {
  ctx.seq.value += 1;
  const providerId = `sim-out-${ctx.seq.value}`;
  const at = simNow(ctx.clock);
  const row = {
    id: `sim-msg-${ctx.seq.value}`,
    conversation_id: ctx.conversationId,
    account_id: ctx.accountId,
    sender_type: "bot",
    content_type: input.kind === "text" ? "text" : input.kind === "media" ? "document" : "interactive",
    content_text: input.text,
    media_url: input.mediaUrl ?? null,
    message_id: providerId,
    status: "sent",
    created_at: at,
    received_at: at,
  };
  (ctx.tables.messages ??= []).push(row);
  ctx.outbound.push({
    id: providerId,
    at,
    kind: input.kind,
    provider: ctx.provider,
    source: input.source,
    text: input.text,
    ...(input.options ? { options: input.options } : {}),
    ...(input.mediaUrl ? { media_url: input.mediaUrl } : {}),
  });
  return { whatsapp_message_id: providerId, id: row.id };
}
