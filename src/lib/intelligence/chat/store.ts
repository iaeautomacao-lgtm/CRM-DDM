// Histórico do chat (wacrm.intelligence_chats / intelligence_messages,
// migration 150) e o teto diário de perguntas por conta. Sempre com o
// cliente service role e filtro explícito por conta + usuário: o RLS da
// 150 é a segunda barreira, não a única.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolvePeriod } from "../period";
import type { IntelligenceScope } from "../scope";
import type { ChatHistoryMessage, ChatRole, ToolCallRecord } from "./types";

export const DEFAULT_DAILY_MAX_MESSAGES = 200;
/** Mensagens anteriores do chat enviadas ao modelo como contexto. */
export const HISTORY_CONTEXT_MESSAGES = 20;
export const CHAT_TITLE_MAX = 80;

export const DAILY_LIMIT_MESSAGE =
  "O limite diário de perguntas ao DDM Intelligence desta conta foi atingido. Ele é renovado à meia-noite (horário de Brasília) — tente de novo amanhã ou fale com o administrador.";

/** Teto diário de perguntas por conta (env INTELLIGENCE_DAILY_MAX_MESSAGES). */
export function dailyMessageLimit(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.INTELLIGENCE_DAILY_MAX_MESSAGES?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_MAX_MESSAGES;
}

/** Perguntas (mensagens do usuário) da conta desde a meia-noite de Brasília. */
export async function countAccountQuestionsToday(
  db: SupabaseClient,
  accountId: string,
  nowMs = Date.now(),
): Promise<number> {
  const startOfDay = resolvePeriod({ preset: "today" }, nowMs).from;
  const { count, error } = await db
    .from("intelligence_messages")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("role", "user")
    .gte("created_at", startOfDay);
  if (error) throw new Error(`Falha ao contar perguntas do dia: ${error.message}`);
  return count ?? 0;
}

export interface ChatSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface StoredChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  tool_calls: ToolCallRecord[] | null;
  created_at: string;
}

export function chatTitleFrom(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length <= CHAT_TITLE_MAX ? oneLine : `${oneLine.slice(0, CHAT_TITLE_MAX - 1)}…`;
}

type Owner = Pick<IntelligenceScope, "accountId" | "userId">;

export async function getOwnedChat(db: SupabaseClient, owner: Owner, chatId: string): Promise<ChatSummary | null> {
  const { data, error } = await db
    .from("intelligence_chats")
    .select("id, title, created_at, updated_at")
    .eq("id", chatId)
    .eq("account_id", owner.accountId)
    .eq("user_id", owner.userId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao carregar o chat: ${error.message}`);
  return (data as ChatSummary | null) ?? null;
}

export async function createChat(db: SupabaseClient, owner: Owner, title: string): Promise<ChatSummary> {
  const { data, error } = await db
    .from("intelligence_chats")
    .insert({ account_id: owner.accountId, user_id: owner.userId, title })
    .select("id, title, created_at, updated_at")
    .limit(1);
  const row = (data as ChatSummary[] | null)?.[0];
  if (error || !row) throw new Error(`Falha ao criar o chat: ${error?.message ?? "sem retorno"}`);
  return row;
}

export async function listChats(db: SupabaseClient, owner: Owner, limit = 50): Promise<ChatSummary[]> {
  const { data, error } = await db
    .from("intelligence_chats")
    .select("id, title, created_at, updated_at")
    .eq("account_id", owner.accountId)
    .eq("user_id", owner.userId)
    .order("updated_at", { ascending: false })
    .range(0, limit - 1);
  if (error) throw new Error(`Falha ao listar os chats: ${error.message}`);
  return (data as ChatSummary[] | null) ?? [];
}

export async function loadChatMessages(db: SupabaseClient, chatId: string, limit = 200): Promise<StoredChatMessage[]> {
  const { data, error } = await db
    .from("intelligence_messages")
    .select("id, role, content, tool_calls, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .range(0, limit - 1);
  if (error) throw new Error(`Falha ao carregar as mensagens: ${error.message}`);
  return ((data as StoredChatMessage[] | null) ?? []).reverse();
}

/** Últimas mensagens do chat, para contexto do modelo (mais antiga primeiro). */
export async function loadHistoryForModel(db: SupabaseClient, chatId: string): Promise<ChatHistoryMessage[]> {
  const rows = await loadChatMessages(db, chatId, HISTORY_CONTEXT_MESSAGES);
  return rows.filter((m) => m.content.trim()).map((m) => ({ role: m.role, content: m.content }));
}

export async function insertChatMessage(
  db: SupabaseClient,
  owner: Owner,
  chatId: string,
  message: { role: ChatRole; content: string; tool_calls?: ToolCallRecord[] | null },
): Promise<string> {
  const { data, error } = await db
    .from("intelligence_messages")
    .insert({
      chat_id: chatId,
      account_id: owner.accountId,
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls ?? null,
    })
    .select("id")
    .limit(1);
  const id = (data as Array<{ id: string }> | null)?.[0]?.id;
  if (error || !id) throw new Error(`Falha ao salvar a mensagem: ${error?.message ?? "sem retorno"}`);
  return id;
}

export async function touchChat(db: SupabaseClient, chatId: string): Promise<void> {
  const { error } = await db
    .from("intelligence_chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", chatId);
  if (error) console.error("[intelligence/chat] touchChat:", error.message);
}
