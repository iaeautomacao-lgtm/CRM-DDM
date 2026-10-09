import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { endActiveRunForConversation } from '@/lib/flows/engine'
import { buildHumanClosePatch } from '@/lib/conversations/outcome'

// Ações em lote do Monitoramento (TASK1 item 1). Cada item repete as validações das rotas
// unitárias (/api/conversations/[id]/transfer e /close): conversa visível pela RLS do usuário,
// mesma conta, escrita pelo service role e ator completado no histórico de atribuição.
// Um item com erro não derruba os demais: o resultado é por item.

export const BATCH_MAX_ITEMS = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type BatchItemCode =
  | 'not_found'
  | 'invalid_id'
  | 'already_mine'
  | 'conversation_closed'
  | 'error'

export interface BatchItemResult {
  conversation_id: string
  ok: boolean
  code?: BatchItemCode
  error?: string
}

export type BatchParse =
  | { ok: true; ids: string[] }
  | { ok: false; error: string; status: 400 | 413 }

/** Valida e deduplica `conversation_ids` (1..BATCH_MAX_ITEMS UUIDs). */
export function parseBatchIds(raw: unknown): BatchParse {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'Informe conversation_ids', status: 400 }
  }
  if (raw.length > BATCH_MAX_ITEMS) {
    return { ok: false, error: `Máximo de ${BATCH_MAX_ITEMS} conversas por chamada`, status: 413 }
  }
  if (!raw.every((v) => typeof v === 'string' && UUID_RE.test(v))) {
    return { ok: false, error: 'conversation_ids precisa conter só UUIDs', status: 400 }
  }
  return { ok: true, ids: [...new Set(raw as string[])] }
}

export function summarizeBatch(results: BatchItemResult[]) {
  const ok = results.filter((r) => r.ok).length
  return { total: results.length, ok, failed: results.length - ok }
}

interface Ctx {
  supabase: SupabaseClient
  accountId: string
  userId: string
}

async function visibleConversation(ctx: Ctx, id: string, columns: string) {
  const { data, error } = await ctx.supabase
    .from('conversations')
    .select(columns)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .limit(1)
  if (error) throw error
  return ((data ?? []) as unknown as Array<Record<string, unknown>>)[0] ?? null
}

/** "Transferir para mim": mesma regra do /transfer com agent_id = o próprio usuário. */
export async function transferToMe(ctx: Ctx, id: string, reason: string): Promise<BatchItemResult> {
  try {
    const current = await visibleConversation(ctx, id, 'id, assigned_agent_id')
    if (!current) return { conversation_id: id, ok: false, code: 'not_found', error: 'Conversa não encontrada' }
    if (current.assigned_agent_id === ctx.userId) {
      return { conversation_id: id, ok: true, code: 'already_mine' }
    }
    const db = supabaseAdmin()
    const startedAt = new Date().toISOString()
    const { data: updated, error } = await db
      .from('conversations')
      .update({ assigned_agent_id: ctx.userId })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
    if (error) throw error
    if (!updated?.[0]) return { conversation_id: id, ok: false, code: 'not_found', error: 'Conversa não encontrada' }

    const { data: rows } = await db
      .from('conversation_assignments')
      .select('id')
      .eq('conversation_id', id)
      .is('actor_id', null)
      .gte('created_at', startedAt)
      .order('created_at', { ascending: false })
      .limit(1)
    const row = rows?.[0]
    if (row) {
      await db
        .from('conversation_assignments')
        .update({ actor_id: ctx.userId, ...(reason ? { reason } : {}) })
        .eq('id', row.id)
    }
    return { conversation_id: id, ok: true }
  } catch (err) {
    return { conversation_id: id, ok: false, code: 'error', error: err instanceof Error ? err.message : 'erro' }
  }
}

/** "Finalizar com tabulação": mesma regra do /close (tag outcome já validada pelo chamador). */
export async function closeWithOutcome(ctx: Ctx, id: string, outcomeTagId: string): Promise<BatchItemResult> {
  try {
    const visible = await visibleConversation(ctx, id, 'id, assigned_agent_id')
    if (!visible) return { conversation_id: id, ok: false, code: 'not_found', error: 'Conversa não encontrada ou sem permissão' }
    const patch = buildHumanClosePatch({
      outcomeTagId,
      userId: ctx.userId,
      assignedAgentId: (visible.assigned_agent_id as string | null) ?? null,
    })
    const { data: updated, error } = await supabaseAdmin()
      .from('conversations')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
    if (error) throw error
    if (!updated?.[0]) return { conversation_id: id, ok: false, code: 'not_found', error: 'Conversa não encontrada' }
    try {
      await endActiveRunForConversation(id, 'conversation_closed')
    } catch (err) {
      console.error('[conversations/batch] failed to end active flow:', err)
    }
    return { conversation_id: id, ok: true }
  } catch (err) {
    return { conversation_id: id, ok: false, code: 'error', error: err instanceof Error ? err.message : 'erro' }
  }
}

/** Executa com concorrência limitada, preservando a ordem de entrada. */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
