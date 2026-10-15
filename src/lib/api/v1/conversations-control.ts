// Controle do atendimento pela API pública (Onda 2): leitura da conversa, transferir (respeitando a PAUSA) e encerrar com tabulação.
// Sempre escopado pela conta da chave (service role não tem RLS). Reaproveita as regras da rota interna do painel:
//   - encerrar = o mesmo UPDATE (status, outcome_tag_id, outcome_set_*), então os triggers já existentes disparam `conversation.closed` e, com a
//     tabulação 142, `agreement.created`; a origem fica `automation` (um sistema externo agindo; não mexe nos relatórios de tabulação);
//   - transferir = um único UPDATE; o histórico (conversation_assignments) vem do trigger e aqui se completa ator e motivo;
//   - atendente EM PAUSA (migrations 370/371): 409 `conflict` com `reason: 'agent_paused'` até vir `confirm_paused: true`.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, notFound } from '@/lib/api/v1/respond';
import { pausedAgentIds } from '@/lib/pausas/availability';

type Db = SupabaseClient;
const unavailable = (what: string) => new ApiError('unavailable', `Não foi possível ${what}; tente novamente`, 503);

export interface ConversationRow {
  id: string;
  account_id: string;
  contact_id: string;
  status: 'open' | 'pending' | 'closed';
  assigned_agent_id: string | null;
  team_id: string | null;
  config_id: string | null;
  waha_session: string | null;
  outcome_tag_id: string | null;
  closed_at: string | null;
}
export const CONVERSATION_COLUMNS = 'id, account_id, contact_id, status, assigned_agent_id, team_id, config_id, waha_session, outcome_tag_id, closed_at';

export async function loadConversation(db: Db, accountId: string, id: string): Promise<ConversationRow> {
  const { data, error } = await db.from('conversations').select(CONVERSATION_COLUMNS).eq('id', id).eq('account_id', accountId).limit(1);
  if (error) throw unavailable('consultar a conversa');
  const row = ((data ?? [])[0] as ConversationRow | undefined) ?? null;
  if (!row) throw notFound('Conversa não encontrada');
  return row;
}

/** Atendente ativo da MESMA conta que pode atender (operador, supervisor, admin ou proprietário). Qualquer outro caso = 404 (não revela quem existe). */
export async function validateAssignee(db: Db, accountId: string, userId: string): Promise<{ id: string; name: string }> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id, full_name, account_role')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .is('deactivated_at', null)
    .in('account_role', ['owner', 'admin', 'supervisor', 'agent'])
    .limit(1);
  if (error) throw unavailable('consultar o atendente');
  const row = (data ?? [])[0] as { user_id: string; full_name: string | null } | undefined;
  if (!row) throw notFound('Atendente não encontrado');
  return { id: row.user_id, name: (row.full_name ?? '').trim() || 'Atendente' };
}

export async function validateTeam(db: Db, accountId: string, teamId: string): Promise<void> {
  const { data, error } = await db.from('teams').select('id').eq('id', teamId).eq('account_id', accountId).limit(1);
  if (error) throw unavailable('consultar a equipe');
  if (!(data ?? [])[0]) throw notFound('Equipe não encontrada');
}

/**
 * Pausa: atribuir a quem está em pausa só com confirmação. Devolve true quando a confirmação foi usada (para a auditoria).
 * Fail-closed: se não der para ler as pausas, também pede a confirmação (nunca atribui no escuro).
 */
export async function guardPausedAssignee(db: Db, agent: { id: string; name: string }, confirmPaused: boolean): Promise<boolean> {
  if (!(await pausedAgentIds(db, [agent.id])).has(agent.id)) return false;
  if (confirmPaused) return true;
  const { data } = await db.from('agent_pauses').select('reason_name, started_at').eq('user_id', agent.id).is('ended_at', null).limit(1);
  const pause = ((data ?? [])[0] as { reason_name: string; started_at: string } | undefined) ?? null;
  throw new ApiError('conflict', `${agent.name} está em pausa. Repita com 'confirm_paused': true para atribuir mesmo assim.`, 409, undefined, undefined, {
    reason: 'agent_paused',
    agent: { id: agent.id, name: agent.name },
    pause: pause ? { reason: pause.reason_name, since: pause.started_at } : null,
  });
}

export interface ConversationView {
  id: string;
  status: 'open' | 'pending' | 'closed';
  assignee_id: string | null;
  team_id: string | null;
  contact_id: string;
  channel: { id: string | null; waha_session: string | null };
}

export const toConversationView = (c: ConversationRow): ConversationView => ({
  id: c.id,
  status: c.status,
  assignee_id: c.assigned_agent_id ?? null,
  team_id: c.team_id ?? null,
  contact_id: c.contact_id,
  channel: { id: c.config_id ?? null, waha_session: c.waha_session ?? null },
});

// ── transferir ───────────────────────────────────────────────────────────────
export interface TransferArgs {
  accountId: string;
  conversation: ConversationRow;
  /** undefined = não mexer; null = remover. */
  assigneeId: string | null | undefined;
  teamId: string | null | undefined;
  confirmPaused: boolean;
  /** Quem criou a chave (null se foi removido): vira o ator no histórico de atribuição. */
  actorUserId: string | null;
  reason: string | undefined;
}

export async function transferConversation(db: Db, a: TransferArgs): Promise<{ conversation: ConversationRow; changed: boolean; pausedConfirmed: boolean }> {
  const c = a.conversation;
  if (c.status === 'closed') {
    throw new ApiError('conflict', 'A conversa está encerrada; abra uma nova para atender de novo.', 409, undefined, undefined, { reason: 'conversation_closed' });
  }
  let pausedConfirmed = false;
  if (a.assigneeId) {
    const agent = await validateAssignee(db, a.accountId, a.assigneeId);
    if (a.assigneeId !== c.assigned_agent_id) pausedConfirmed = await guardPausedAssignee(db, agent, a.confirmPaused);
  }
  if (a.teamId) await validateTeam(db, a.accountId, a.teamId);

  const patch: Record<string, string | null> = {};
  if (a.assigneeId !== undefined && a.assigneeId !== c.assigned_agent_id) patch.assigned_agent_id = a.assigneeId;
  if (a.teamId !== undefined && a.teamId !== c.team_id) patch.team_id = a.teamId;
  if (Object.keys(patch).length === 0) return { conversation: c, changed: false, pausedConfirmed: false };

  const startedAt = new Date().toISOString();
  const { data, error } = await db.from('conversations').update(patch).eq('id', c.id).eq('account_id', a.accountId).neq('status', 'closed').select(CONVERSATION_COLUMNS);
  if (error) throw unavailable('transferir a conversa');
  const updated = ((data ?? [])[0] as ConversationRow | undefined) ?? null;
  if (!updated) throw new ApiError('conflict', 'A conversa foi encerrada enquanto o pedido era processado.', 409, undefined, undefined, { reason: 'conversation_closed' });

  // Completa a linha que o trigger acabou de gravar (ator = quem criou a chave; motivo e marca de pausa confirmada).
  const note = pausedConfirmed ? `(atendente em pausa, confirmado)${a.reason ? ` ${a.reason}` : ''}`.slice(0, 500) : a.reason;
  const { data: rows } = await db
    .from('conversation_assignments')
    .select('id')
    .eq('conversation_id', c.id)
    .is('actor_id', null)
    .gte('created_at', startedAt)
    .order('created_at', { ascending: false })
    .limit(1);
  const row = ((rows ?? [])[0] as { id: string } | undefined) ?? null;
  if (row && (a.actorUserId || note)) {
    await db.from('conversation_assignments').update({ ...(a.actorUserId ? { actor_id: a.actorUserId } : {}), ...(note ? { reason: note } : {}) }).eq('id', row.id);
  }
  return { conversation: updated, changed: true, pausedConfirmed };
}

// ── encerrar ─────────────────────────────────────────────────────────────────
export interface Tabulation {
  id: string;
  code: number | null;
  name: string;
}

/** Tabulação da conta por código (`codigo_tabulacao`) ou id. 404 para inexistente ou de outra conta. */
export async function resolveTabulation(db: Db, accountId: string, by: { id: string | null; code: number | null }): Promise<Tabulation> {
  let query = db.from('tags').select('id, name, codigo_tabulacao').eq('account_id', accountId).eq('kind', 'outcome');
  query = by.id ? query.eq('id', by.id) : query.eq('codigo_tabulacao', by.code as number);
  const { data, error } = await query.limit(1);
  if (error) throw unavailable('consultar a tabulação');
  const row = (data ?? [])[0] as { id: string; name: string; codigo_tabulacao: number | null } | undefined;
  if (!row) throw notFound('Tabulação não encontrada; veja GET /tabulations');
  return { id: row.id, code: row.codigo_tabulacao ?? null, name: row.name };
}

export interface CloseArgs {
  accountId: string;
  conversation: ConversationRow;
  tabulation: Tabulation;
  note: string | undefined;
  /** Autor registrado na tabulação e na nota (quem criou a chave; sem ele, o dono da conta). */
  actorUserId: string | null;
  noteAuthorId: string;
}

export async function closeConversation(db: Db, a: CloseArgs): Promise<{ conversation: ConversationRow; changed: boolean }> {
  const c = a.conversation;
  if (c.status === 'closed') {
    if (c.outcome_tag_id === a.tabulation.id) return { conversation: c, changed: false };
    throw new ApiError('conflict', 'A conversa já está encerrada com outra tabulação.', 409, undefined, undefined, { reason: 'already_closed' });
  }
  const patch = {
    status: 'closed',
    outcome_tag_id: a.tabulation.id,
    outcome_source: 'automation',
    outcome_set_by: a.actorUserId,
    outcome_set_at: new Date().toISOString(),
  };
  const { data, error } = await db.from('conversations').update(patch).eq('id', c.id).eq('account_id', a.accountId).neq('status', 'closed').select(CONVERSATION_COLUMNS);
  if (error) throw unavailable('encerrar a conversa');
  const updated = ((data ?? [])[0] as ConversationRow | undefined) ?? null;
  if (!updated) {
    // Alguém encerrou entre a leitura e a escrita: reavalia (mesma tabulação = ok; outra = 409).
    const fresh = await loadConversation(db, a.accountId, c.id);
    if (fresh.status === 'closed' && fresh.outcome_tag_id === a.tabulation.id) return { conversation: fresh, changed: false };
    throw new ApiError('conflict', 'A conversa já está encerrada com outra tabulação.', 409, undefined, undefined, { reason: 'already_closed' });
  }
  if (a.note) {
    // Nota do contato (aba "Notas" do painel), nunca enviada ao cliente. Falha na nota não desfaz o encerramento.
    const { error: noteError } = await db.from('contact_notes').insert({ contact_id: c.contact_id, account_id: a.accountId, user_id: a.noteAuthorId, note_text: `[Encerramento pela API] ${a.note}` });
    if (noteError) console.error('[API conversations/close] nota não gravada:', noteError.message);
  }
  return { conversation: updated, changed: true };
}
