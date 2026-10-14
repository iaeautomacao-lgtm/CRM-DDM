// Acordito: evento de feedback por sugestão (used | edited | ignored) para a métrica. Só o servidor grava (service role).
import type { SupabaseClient } from '@supabase/supabase-js'

export const COPILOT_FEEDBACK_ACTIONS = ['used', 'edited', 'ignored'] as const
export type CopilotFeedbackAction = (typeof COPILOT_FEEDBACK_ACTIONS)[number]

export async function recordCopilotFeedback(
  db: Pick<SupabaseClient, 'from'>,
  input: { accountId: string; userId: string; suggestionId: string; action: CopilotFeedbackAction },
): Promise<{ ok: true } | { ok: false }> {
  // A sugestão tem de existir NESTA conta (o id mora dentro do jsonb do cache).
  const { data, error } = await db
    .from('copilot_suggestions')
    .select('conversation_id')
    .eq('account_id', input.accountId)
    .contains('suggestions', [{ id: input.suggestionId }])
    .limit(1)
  if (error) throw new Error(`copilot: busca da sugestão falhou (${error.code ?? 'erro'})`)
  const conversationId = (data?.[0] as { conversation_id?: string } | undefined)?.conversation_id
  if (!conversationId) return { ok: false }

  const { error: insertError } = await db.from('copilot_events').insert({
    account_id: input.accountId,
    conversation_id: conversationId,
    user_id: input.userId,
    suggestion_id: input.suggestionId,
    action: input.action,
  })
  if (insertError) throw new Error(`copilot: gravação do evento falhou (${insertError.code ?? 'erro'})`)
  return { ok: true }
}
