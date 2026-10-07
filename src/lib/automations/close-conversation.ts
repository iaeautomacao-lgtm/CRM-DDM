import type { SupabaseClient } from '@supabase/supabase-js'

/** codigo_tabulacao da tag "Sem Tabulação" semeada por conta (migration 041). */
export const SEM_TABULACAO_CODIGO = 16

export type AutomationCloseResult = 'closed' | 'already_closed' | 'not_found'

export interface AutomationCloseInput {
  accountId: string
  conversationId: string
  /** Tag configurada no passo (pode vir vazia de automações antigas). */
  configuredOutcomeTagId?: string | null
}

/**
 * Passo `close_conversation` das automações.
 *
 * Antes o UPDATE filtrava por account_id + contact_id: fechava TODAS as
 * conversas do contato (inclusive as já fechadas/tabuladas por um humano)
 * e sobrescrevia o outcome_tag_id de cada uma. Agora:
 *   - fecha só a conversa resolvida pelo passo (por id, dentro da conta);
 *   - não mexe em conversa já fechada (status <> 'closed');
 *   - nunca sobrescreve uma tabulação existente — a tag configurada (ou o
 *     fallback "Sem Tabulação") só entra quando outcome_tag_id é null.
 */
export async function closeConversationForAutomation(
  db: SupabaseClient,
  input: AutomationCloseInput,
): Promise<AutomationCloseResult> {
  const { data: conversation, error } = await db
    .from('conversations')
    .select('id, status, outcome_tag_id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle()

  if (error) throw error
  if (!conversation) return 'not_found'
  if (conversation.status === 'closed') return 'already_closed'

  const patch: Record<string, unknown> = {
    status: 'closed',
    updated_at: new Date().toISOString(),
  }

  if (!conversation.outcome_tag_id) {
    const outcomeTagId =
      (input.configuredOutcomeTagId ? input.configuredOutcomeTagId : null) ??
      (await resolveFallbackOutcomeTagId(db, input.accountId))
    if (outcomeTagId) patch.outcome_tag_id = outcomeTagId
  }

  const { error: updateError } = await db
    .from('conversations')
    .update(patch)
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .neq('status', 'closed')

  if (updateError) throw updateError
  return 'closed'
}

async function resolveFallbackOutcomeTagId(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  // Sem tag configurada no passo — cai na "Sem Tabulação" da conta para
  // que um fechamento por automação ainda registre um desfecho.
  const { data, error } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .eq('kind', 'outcome')
    .eq('codigo_tabulacao', SEM_TABULACAO_CODIGO)
    .limit(1)

  const tag = data?.[0] as { id: string } | undefined
  if (error || !tag) {
    console.warn(
      `[automations] close_conversation: no outcome_tag_id configured and fallback tag (codigo_tabulacao=${SEM_TABULACAO_CODIGO}) not found for account`,
      accountId,
      error,
    )
    return null
  }
  return tag.id
}
