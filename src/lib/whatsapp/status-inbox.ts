// Webhook de status da Meta DURÁVEL e em lote (migration 185, P1-2).
//
// Fluxo:
//   POST /api/whatsapp/webhook → valida o HMAC por canal → extractStatusEvents → ingestStatusEvents
//   (UMA chamada por POST, ANTES do 200; falhou ⇒ o webhook responde 500 e a Meta reenvia) →
//   after(): drainStatusInbox (no máx. ~1×/s no cluster, vez ganha no banco) e o cron de 1/min como
//   rede de segurança. Nada vive em memória entre o 200 e o apply: o evento já está no banco.
//
// Compatibilidade: se a migration 185 não estiver aplicada (função inexistente), `ingestStatusEvents`
// devolve `missing` e o webhook cai no caminho antigo (3 chamadas por evento, depois do 200).

import { shouldProcessStatus } from './webhook-fast-path'

/** Teto de corpo do POST da Meta (statuses/mensagens são pequenos; 1 MB é folgado). */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576

export interface StatusEventInput {
  message_id: string
  status: 'delivered' | 'read' | 'failed'
  /** "Meta: <title> (code <code>)" — mesmo texto que o webhook sempre montou. */
  error_text: string | null
  /** Segundos desde epoch (campo `timestamp` da Meta). */
  ts: number | null
  /** Conta/canal cujo app_secret validou o HMAC deste POST (nunca vem do corpo). */
  account_id: string
  channel_id: string
}

interface MetaStatus {
  id?: string
  status?: string
  timestamp?: string
  errors?: Array<{ code?: number; title?: string }>
}

interface BodyLike {
  entry?: Array<{
    id?: string
    changes?: Array<{ field?: string; value?: { metadata?: { phone_number_id?: string }; statuses?: MetaStatus[] } }>
  }>
}

export function failureReasonOf(errors: MetaStatus['errors']): string | null {
  const first = errors?.[0]
  return first ? `Meta: ${first.title} (code ${first.code})` : null
}

/**
 * Statuses delivered/read/failed de TODAS as changes cujo canal validou a assinatura. A conta vem do
 * canal verificado, nunca do conteúdo do corpo. `sent` não agrega (descartado, como sempre).
 */
export function extractStatusEvents(
  body: BodyLike,
  verifiedChannels: ReadonlyMap<string, { id: string; account_id: string }>,
  channelKeyOf: (entry: { id?: string }, change: { field?: string; value?: { metadata?: { phone_number_id?: string } } }) => string | null,
): StatusEventInput[] {
  const events: StatusEventInput[] = []
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const key = channelKeyOf(entry, change)
      const channel = key ? verifiedChannels.get(key) : undefined
      if (!channel) continue
      for (const status of change.value?.statuses ?? []) {
        if (!status?.id || !status.status || !shouldProcessStatus(status.status)) continue
        const ts = Number(status.timestamp)
        events.push({
          message_id: status.id,
          status: status.status as StatusEventInput['status'],
          error_text: failureReasonOf(status.errors),
          ts: Number.isFinite(ts) && ts > 0 ? ts : null,
          account_id: channel.account_id,
          channel_id: channel.id,
        })
      }
    }
  }
  return events
}

type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
type Db = { rpc: Rpc }

function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883' || /could not find the function|does not exist/i.test(error?.message ?? '')
}

// Migration 185 ausente: não insiste a cada POST; confere de novo depois de 60 s (sem restart).
const MISSING_RECHECK_MS = 60_000
let missingUntil = 0

/** Só para testes. */
export function resetStatusInboxState(): void {
  missingUntil = 0
}

export type IngestResult =
  | { ok: true; inserted: number }
  | { ok: false; missing: true }
  | { ok: false; missing: false; error: string }

/** Grava o lote no inbox (1 chamada). `missing` = migration 185 não aplicada (usar o caminho antigo). */
export async function ingestStatusEvents(db: Db, events: readonly StatusEventInput[], now: number = Date.now()): Promise<IngestResult> {
  if (events.length === 0) return { ok: true, inserted: 0 }
  if (now < missingUntil) return { ok: false, missing: true }
  const { data, error } = await db.rpc('ingest_status_events', { p_events: events })
  if (error) {
    if (isMissingFunction(error)) {
      missingUntil = now + MISSING_RECHECK_MS
      return { ok: false, missing: true }
    }
    return { ok: false, missing: false, error: error.message ?? 'erro desconhecido' }
  }
  return { ok: true, inserted: typeof data === 'number' ? data : 0 }
}

export interface DrainSummary {
  batches: number
  claimed: number
  failed: number
  /** true se a migration 185 não está aplicada. */
  missing: boolean
}

export interface DrainOptions {
  limit?: number
  maxBatches?: number
  /** Não inicia outro lote depois disso (orçamento do tick/after). */
  shouldStop?: () => boolean
  /** Webhook: só drena se ganhar a vez (~1×/s no cluster). Cron: não precisa. */
  requireTurn?: boolean
}

/** Aplica o inbox em lotes (apply_dispatch_statuses). Nunca lança. */
export async function drainStatusInbox(db: Db, options: DrainOptions = {}): Promise<DrainSummary> {
  const limit = options.limit ?? 500
  const maxBatches = options.maxBatches ?? 5
  const summary: DrainSummary = { batches: 0, claimed: 0, failed: 0, missing: false }
  try {
    if (options.requireTurn) {
      const { data, error } = await db.rpc('try_claim_status_drain', { p_interval_ms: 1000 })
      if (error) {
        summary.missing = isMissingFunction(error)
        return summary
      }
      if (data !== true) return summary
    }
    for (let i = 0; i < maxBatches; i++) {
      if (options.shouldStop?.()) break
      const { data, error } = await db.rpc('apply_dispatch_statuses', { p_limit: limit })
      if (error) {
        if (isMissingFunction(error)) summary.missing = true
        else console.error('[status-inbox] falha ao aplicar o lote de status:', error.message)
        break
      }
      const result = (data ?? {}) as { claimed?: number; failed?: number }
      const claimed = Number(result.claimed ?? 0)
      summary.batches++
      summary.claimed += claimed
      summary.failed += Number(result.failed ?? 0)
      if (claimed < limit) break
    }
  } catch (error) {
    console.error('[status-inbox] falha inesperada ao drenar:', error instanceof Error ? error.message : error)
  }
  return summary
}
