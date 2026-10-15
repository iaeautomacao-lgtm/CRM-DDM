// Histórico da conversa em blocos + memória das últimas conversas abertas.
//
// Antes, abrir uma conversa baixava TODAS as mensagens numa consulta só (e o
// banco corta em 1000 linhas: nas conversas longas as mais novas sumiam).
// Agora entram as mais recentes e as antigas vêm sob demanda, ao rolar para
// cima. A memória das últimas conversas deixa a troca instantânea: a conversa
// aparece na hora e é atualizada em segundo plano.

import type { Message } from "@/types";

/** Mensagens por bloco. */
export const THREAD_PAGE_SIZE = 60;

/** Conversas guardadas na memória (as mais recentes em uso). */
export const THREAD_CACHE_SIZE = 8;

/** Instante usado para ordenar (o mesmo da consulta: received_at; cai em created_at em linha antiga). */
export function messageStamp(m: Pick<Message, "received_at" | "created_at">): string {
  return m.received_at ?? m.created_at;
}

const byStamp = (a: Message, b: Message) => {
  const sa = messageStamp(a);
  const sb = messageStamp(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Junta o bloco mais recente recém-buscado com o que já estava na tela, sem perder as mensagens antigas já
 * carregadas. Só mantém as antigas se houver sobreposição com o bloco novo (senão ficaria um buraco no meio:
 * mensagens chegaram enquanto a conversa estava fechada) — nesse caso o resto volta a ser carregado ao rolar.
 */
export function mergeLatestPage(existing: Message[], fetchedAsc: Message[]): Message[] {
  if (fetchedAsc.length === 0) return [];
  const oldest = messageStamp(fetchedAsc[0]);
  const real = existing.filter((m) => !m.id.startsWith("temp-"));
  const overlaps = real.some((m) => messageStamp(m) >= oldest);
  const older = overlaps ? real.filter((m) => messageStamp(m) < oldest) : [];
  return [...older, ...fetchedAsc];
}

/** Põe um bloco de mensagens antigas na frente, sem repetir nenhuma. */
export function prependOlder(existing: Message[], olderAsc: Message[]): Message[] {
  const known = new Set(existing.map((m) => m.id));
  const fresh = olderAsc.filter((m) => !known.has(m.id));
  if (fresh.length === 0) return existing;
  return [...fresh, ...existing].sort(byStamp);
}

// ---- Memória das últimas conversas (módulo: dura enquanto a aba está aberta) ----

const cache = new Map<string, Message[]>();

/** Mensagens guardadas da conversa, se houver. */
export function getCachedThread(conversationId: string): Message[] | null {
  const hit = cache.get(conversationId);
  if (!hit) return null;
  // Usada agora: vai para o fim (a mais antiga sai primeiro).
  cache.delete(conversationId);
  cache.set(conversationId, hit);
  return hit;
}

/** Guarda as mensagens (sem as otimistas `temp-`). Lista vazia não é guardada. */
export function cacheThread(conversationId: string, messages: Message[]): void {
  const real = messages.filter((m) => !m.id.startsWith("temp-"));
  if (real.length === 0) {
    cache.delete(conversationId);
    return;
  }
  cache.delete(conversationId);
  cache.set(conversationId, real);
  while (cache.size > THREAD_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Esquece uma conversa (apagada) ou todas (troca de conta). */
export function clearCachedThread(conversationId?: string): void {
  if (conversationId) cache.delete(conversationId);
  else cache.clear();
}
