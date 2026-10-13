// Linha (wacrm.whatsapp_config) de uma conversa — decisão do dono de 13/10 (item 17): em conta com várias linhas, a IA
// responde pela MESMA linha da conversa, sem adivinhar número. Ordem:
//   1. a linha que o chamador já sabe (configId do webhook/fluxo), escopada pela conta;
//   2. a da conversa: conversations.config_id; conversa antiga do WAHA sem config_id: a linha da waha_session dela;
//   3. sem pista nenhuma: a ÚNICA linha da conta. Com 2+ linhas, não escolhe (reason "ambiguous").
// Antes: whatsapp_config.eq(account_id).maybeSingle(), que falhava em toda conta com 2+ linhas.

type Row = Record<string, unknown> & { id: string };
type Result<T> = { data: T[] | null; error: { message: string } | null };
// Builder mínimo do supabase-js (só o que esta função usa).
interface Query<T> extends PromiseLike<Result<T>> {
  select(columns: string): Query<T>;
  eq(column: string, value: unknown): Query<T>;
  limit(n: number): Query<T>;
}
interface Db {
  from(table: string): Query<Row>;
}

export type ConversationLine =
  | { line: Row; reason: "configured" | "conversation" | "only_line" }
  | { line: null; reason: "not_found" | "ambiguous" | "error"; error?: string };

export async function resolveConversationLine(
  db: Db,
  input: { accountId: string; conversationId: string | null; configId?: string | null },
): Promise<ConversationLine> {
  const byFilter = async (column: string, value: unknown) => {
    const { data, error } = await db.from("whatsapp_config").select("*").eq("account_id", input.accountId).eq(column, value).limit(2);
    return { rows: data ?? [], error };
  };

  if (input.configId) {
    const { rows, error } = await byFilter("id", input.configId);
    if (error) return { line: null, reason: "error", error: error.message };
    return rows[0] ? { line: rows[0], reason: "configured" } : { line: null, reason: "not_found" };
  }

  if (input.conversationId) {
    const { data: convRows, error: convErr } = await db
      .from("conversations")
      .select("config_id, waha_session")
      .eq("id", input.conversationId)
      .eq("account_id", input.accountId)
      .limit(1);
    if (convErr) return { line: null, reason: "error", error: convErr.message };
    const conv = (convRows?.[0] ?? null) as { config_id?: string | null; waha_session?: string | null } | null;
    if (conv?.config_id) {
      const { rows, error } = await byFilter("id", conv.config_id);
      if (error) return { line: null, reason: "error", error: error.message };
      if (rows[0]) return { line: rows[0], reason: "conversation" };
    } else if (conv?.waha_session) {
      const { rows, error } = await byFilter("waha_session", conv.waha_session);
      if (error) return { line: null, reason: "error", error: error.message };
      if (rows.length === 1) return { line: rows[0], reason: "conversation" };
    }
  }

  const { data, error } = await db.from("whatsapp_config").select("*").eq("account_id", input.accountId).limit(2);
  if (error) return { line: null, reason: "error", error: error.message };
  const rows = data ?? [];
  if (rows.length === 1) return { line: rows[0], reason: "only_line" };
  return { line: null, reason: rows.length === 0 ? "not_found" : "ambiguous" };
}
