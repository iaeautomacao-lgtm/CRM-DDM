/* eslint-disable @typescript-eslint/no-explicit-any -- cliente com schema wacrm ou o do servidor */
// Gravação de mensagem que NÓS acabamos de enviar (IA, fluxo, atendente).
//
// Problema: no WAHA, o próprio envio dispara na hora um webhook "fromMe"
// (eco) com o mesmo message_id. Se o eco é gravado antes, o nosso INSERT
// bate no índice único de messages.message_id (migration 088) e falha — e,
// quando o eco resolveu o contato por outro formato de número (sem o 9º
// dígito, LID), ele ainda cria outro contato/conversa. Resultado: o cliente
// recebe a mensagem, mas ela não aparece na conversa certa do Inbox.
//
// Aqui, em caso de conflito, a linha do eco é "assumida": vai para a
// conversa certa com o remetente certo (bot/agent) e o conteúdo enviado. A
// conversa vazia que o eco criou é apagada.

import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<any, any, any>;
type Row = Record<string, unknown> & { conversation_id: string; message_id?: string | null };

export interface PersistOutboundResult {
  /** id interno da linha gravada (nova ou assumida do eco). */
  id: string | null;
  error: { message: string; code?: string } | null;
  /** true quando a linha veio do eco do WAHA. */
  adoptedEcho: boolean;
}

/** Janela em que uma conversa vazia é tratada como lixo criado pelo eco. */
const ECHO_CONVERSATION_MAX_AGE_MS = 15 * 60_000;

export async function persistOutboundMessage(
  db: Db,
  row: Row,
): Promise<PersistOutboundResult> {
  const { data, error } = await db.from("messages").insert(row).select("id").limit(1);
  if (!error) {
    const first = (Array.isArray(data) ? data[0] : data) as { id?: string } | null | undefined;
    return { id: first?.id ?? null, error: null, adoptedEcho: false };
  }
  if (error.code !== "23505" || !row.message_id) return { id: null, error, adoptedEcho: false };

  const { data: existing, error: findErr } = await db
    .from("messages")
    .select("id, conversation_id")
    .eq("message_id", row.message_id)
    .limit(1);
  const echo = existing?.[0] as { id: string; conversation_id: string } | undefined;
  if (findErr || !echo) return { id: null, error, adoptedEcho: false };

  const echoConversationId = echo.conversation_id;
  const { error: updErr } = await db.from("messages").update(row).eq("id", echo.id);
  if (updErr) return { id: null, error: updErr, adoptedEcho: false };

  if (echoConversationId && echoConversationId !== row.conversation_id) {
    await removeEmptyEchoConversation(db, echoConversationId);
  }
  return { id: echo.id, error: null, adoptedEcho: true };
}

/** Apaga a conversa criada pelo eco se ficou vazia e é recente. */
async function removeEmptyEchoConversation(db: Db, conversationId: string): Promise<void> {
  try {
    const { count } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId);
    if ((count ?? 0) > 0) return;
    const { data: conv } = await db
      .from("conversations")
      .select("created_at")
      .eq("id", conversationId)
      .limit(1);
    const createdAt = (conv?.[0] as { created_at?: string } | undefined)?.created_at;
    if (!createdAt || Date.now() - new Date(createdAt).getTime() > ECHO_CONVERSATION_MAX_AGE_MS) return;
    await db.from("conversations").delete().eq("id", conversationId);
  } catch (err) {
    console.error("[persistOutbound] limpeza da conversa do eco falhou:", err);
  }
}
