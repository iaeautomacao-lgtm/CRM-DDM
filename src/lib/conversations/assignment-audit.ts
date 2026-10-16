// Completa o ator e o motivo na linha de conversation_assignments que o trigger (128) acabou de gravar (actor_id nulo sob service role).
// Revisão de segurança 16/10 (B6): antes a linha era achada por "created_at >= relógio do Node", mas created_at é clock_timestamp() do BANCO — com relógios
// defasados o ator não era gravado, ou caía na linha de outra atribuição simultânea (motor/IA). Agora a linha é a do PRÓPRIO UPDATE: casa pela conversa e
// pelo de→para (atendente e equipe) que esta chamada acabou de aplicar; nenhum relógio do aplicativo entra. Só preenche linha sem ator (nunca sobrescreve).
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = Pick<SupabaseClient, "from">;

export interface AssignmentAuditInput {
  conversationId: string;
  /** Valores ANTES do UPDATE (null = sem atendente/equipe). */
  fromAgent: string | null;
  fromTeam: string | null;
  /** Valores DEPOIS do UPDATE, como o UPDATE devolveu. */
  toAgent: string | null;
  toTeam: string | null;
  actorId?: string | null;
  reason?: string | null;
}

/** Devolve true se completou a linha. Nunca lança por falta de linha; erro de leitura/escrita propaga (a rota decide). */
export async function completeAssignmentAudit(db: Db, a: AssignmentAuditInput): Promise<boolean> {
  if (!a.actorId && !a.reason) return false;
  const match = <T extends { eq: (c: string, v: string) => T; is: (c: string, v: null) => T }>(q: T, column: string, value: string | null): T =>
    value === null ? q.is(column, null) : q.eq(column, value);

  let q = db.from("conversation_assignments").select("id").eq("conversation_id", a.conversationId).is("actor_id", null);
  q = match(q, "from_agent_id", a.fromAgent);
  q = match(q, "to_agent_id", a.toAgent);
  q = match(q, "from_team_id", a.fromTeam);
  q = match(q, "to_team_id", a.toTeam);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1);
  if (error) throw error;
  const row = ((data ?? [])[0] as { id: string } | undefined) ?? null;
  if (!row) return false;
  const patch: Record<string, string> = {};
  if (a.actorId) patch.actor_id = a.actorId;
  if (a.reason) patch.reason = a.reason;
  const { error: updateError } = await db.from("conversation_assignments").update(patch).eq("id", row.id).is("actor_id", null);
  if (updateError) throw updateError;
  return true;
}
