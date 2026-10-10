// Lista de conversas do Chat interno com prévia e não lidas (RPC internal_chat_threads, migration 303).
// Colegas sem conversa continuam vindo da lista de membros; a RPC só traz quem já trocou mensagem.

export interface ChatThread {
  peer_id: string;
  last_message_id: string | null;
  /** Até 140 caracteres; mídia vira "[imagem]", "[áudio]", "[vídeo]" ou "[arquivo]". */
  last_preview: string | null;
  last_at: string | null;
  last_sender_id: string | null;
  unread_count: number;
  last_read_at: string | null;
}

/** Normaliza as linhas da RPC (bigint pode chegar como string). Linhas sem peer_id são ignoradas. */
export function normalizeThreads(rows: unknown): Map<string, ChatThread> {
  const out = new Map<string, ChatThread>();
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.peer_id !== "string" || !r.peer_id) continue;
    const unread = Number(r.unread_count ?? 0);
    out.set(r.peer_id, {
      peer_id: r.peer_id,
      last_message_id: typeof r.last_message_id === "string" ? r.last_message_id : null,
      last_preview: typeof r.last_preview === "string" ? r.last_preview : null,
      last_at: typeof r.last_at === "string" ? r.last_at : null,
      last_sender_id: typeof r.last_sender_id === "string" ? r.last_sender_id : null,
      unread_count: Number.isFinite(unread) && unread > 0 ? Math.floor(unread) : 0,
      last_read_at: typeof r.last_read_at === "string" ? r.last_read_at : null,
    });
  }
  return out;
}

/** Quem tem conversa vem primeiro, da mais recente à mais antiga; os demais mantêm a ordem recebida. */
export function sortWithThreads<T extends { user_id: string }>(contacts: T[], threads: Map<string, ChatThread>): T[] {
  const withThread: T[] = [];
  const without: T[] = [];
  for (const c of contacts) (threads.get(c.user_id)?.last_at ? withThread : without).push(c);
  withThread.sort((a, b) => Date.parse(threads.get(b.user_id)!.last_at!) - Date.parse(threads.get(a.user_id)!.last_at!));
  return [...withThread, ...without];
}

/** Texto da prévia; "Você: ..." quando a última mensagem é minha. Vazio se não há conversa. */
export function previewLine(thread: ChatThread | undefined, myUserId: string | null | undefined): string {
  if (!thread?.last_preview) return "";
  return thread.last_sender_id && thread.last_sender_id === myUserId ? `Você: ${thread.last_preview}` : thread.last_preview;
}

/** "14:05" hoje, "ontem", ou "dd/mm" (horário local). */
export function formatThreadTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/** Contador exibido no selo: 99+ acima de 99. */
export function unreadBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}
