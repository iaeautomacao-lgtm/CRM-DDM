// Carteira fixa na API pública (Onda 2, fase 1): o atendente-dono do contato (wacrm.contacts.owner_user_id, migration 372).
// FASE 1 = só cadastro: PUT/DELETE /contacts/{id}/owner gravam; GET /contacts mostra; POST /conversations usa o dono quando não vem atendente
// nem equipe. A distribuição AUTOMÁTICA não muda (preferir o dono ali é a fase 2 e depende do aval do dono). Sempre escopado pela conta da chave.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, notFound } from '@/lib/api/v1/respond';
import { validateAssignee } from '@/lib/api/v1/conversations-control';
import { pausedAgentIds } from '@/lib/pausas/availability';

type Db = SupabaseClient;
const missingColumn = (e: { code?: string } | null | undefined) => e?.code === '42703' || e?.code === 'PGRST204';
const noMigration = () => new ApiError('unavailable', 'Carteira fixa indisponível: aplique a migration 372', 503);

export interface OwnerView {
  contact_id: string;
  owner: { id: string; name: string } | null;
}

/** Define (assigneeId) ou remove (null) o dono do contato. Atendente de outra conta, desativado ou sem papel de atendimento = 404. */
export async function setContactOwner(db: Db, accountId: string, contactId: string, assigneeId: string | null): Promise<OwnerView> {
  const { data: found, error: findError } = await db.from('contacts').select('id').eq('id', contactId).eq('account_id', accountId).limit(1);
  if (findError) throw new ApiError('unavailable', 'Não foi possível consultar o contato; tente novamente', 503);
  if (!(found ?? [])[0]) throw notFound('Contato não encontrado');

  const agent = assigneeId ? await validateAssignee(db, accountId, assigneeId) : null;
  const { error } = await db.from('contacts').update({ owner_user_id: assigneeId, updated_at: new Date().toISOString() }).eq('id', contactId).eq('account_id', accountId);
  if (error) {
    if (missingColumn(error)) throw noMigration();
    throw new ApiError('unavailable', 'Não foi possível gravar a carteira; tente novamente', 503);
  }
  return { contact_id: contactId, owner: agent ? { id: agent.id, name: agent.name } : null };
}

/**
 * Dono do contato para abrir conversa SEM atendente nem equipe: só vale se existe, está ativo e FORA DE PAUSA (pausado não recebe conversa nova;
 * aqui ninguém pediu o atendente, então cai na fila em vez de dar erro). Qualquer problema de leitura (inclusive sem a 372) = sem dono.
 */
export async function ownerForOpen(db: Db, accountId: string, contactId: string): Promise<string | null> {
  const { data, error } = await db.from('contacts').select('owner_user_id').eq('id', contactId).eq('account_id', accountId).limit(1);
  if (error) return null;
  const ownerId = ((data ?? [])[0] as { owner_user_id?: string | null } | undefined)?.owner_user_id ?? null;
  if (!ownerId) return null;
  try {
    await validateAssignee(db, accountId, ownerId);
  } catch {
    return null;
  }
  return (await pausedAgentIds(db, [ownerId])).has(ownerId) ? null : ownerId;
}
