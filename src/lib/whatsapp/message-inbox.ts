// Inbox DURÁVEL de mensagens recebidas da Meta (migration 201, PRD 15 WH-01/WH-02). Modelo: status-inbox.ts (185).
//
// Fluxo (modo `on`):
//   POST /api/whatsapp/webhook → HMAC por canal → extractMessageEvents → ingestMessageEvents (UMA chamada por POST,
//   ANTES do 200; falhou ⇒ 500 e a Meta reenvia) → after(): drainMessageInbox processa as PRÓPRIAS mensagens (ids
//   devolvidos pela ingestão) e, se ganhar a vez (~1×/s no cluster), o restante da fila. O cron de 1/min é a rede
//   de segurança (lease expirado = processo caiu no meio). Idempotente pelo wamid: linha de `messages` já existente
//   = `duplicate`, nunca duplica. Falha ⇒ backoff 30 s × 2^n; 8 tentativas ⇒ `dead` + log de erro (alerta).
//
// Modo `shadow`: grava no inbox E processa pelo caminho antigo; reconcileShadowInbox só COMPARA (a mensagem existe
// em `messages`?) — mede o que seria perdido sem reprocessar nada.
//
// MODO — flag TEMPORÁRIA de implantação (não é configuração de cliente): WHATSAPP_MESSAGE_INBOX = off | shadow | on.
// Sequência: off → shadow (medir) → on. Quando estabilizar em `on`, trocar DEFAULT_MESSAGE_INBOX_MODE para "on"
// e REMOVER a env (e o caminho inline) num PR de limpeza. Nenhuma outra env é criada por este inbox: limites abaixo
// são constantes.
//
// Compatibilidade: sem a migration 201 (função inexistente) a ingestão devolve `missing` e o webhook cai no caminho
// inline de sempre.

export type MessageInboxMode = 'off' | 'shadow' | 'on'

/** Padrão quando a env não está definida. Virar 'on' depois de validado (ver cabeçalho). */
export const DEFAULT_MESSAGE_INBOX_MODE: MessageInboxMode = 'off'

export function messageInboxMode(env: Record<string, string | undefined> = process.env): MessageInboxMode {
  const raw = env.WHATSAPP_MESSAGE_INBOX?.trim().toLowerCase()
  return raw === 'on' || raw === 'shadow' || raw === 'off' ? raw : DEFAULT_MESSAGE_INBOX_MODE
}

/** Tentativas antes de `dead`. */
export const MESSAGE_INBOX_MAX_ATTEMPTS = 8
const LEASE_SECONDS = 120
const DEFAULT_CLAIM_LIMIT = 20
const DEFAULT_CONCURRENCY = 8
const DRAIN_TURN_MS = 1000

export interface MessageEventInput {
  provider: 'meta'
  account_id: string
  channel_id: string
  message_id: string
  /** Remetente (wa_id/from): define a conversa para a ordenação. */
  sender: string
  /** Segundos desde epoch (timestamp da Meta). */
  ts: number | null
  /** { message, contact, phone_number_id } — nunca token. */
  payload: { message: unknown; contact: unknown; phone_number_id: string }
}

interface MetaMessage {
  id?: string
  from?: string
  timestamp?: string
}
interface BodyLike {
  entry?: Array<{
    id?: string
    changes?: Array<{
      field?: string
      value?: { metadata?: { phone_number_id?: string }; messages?: MetaMessage[]; contacts?: unknown[] }
    }>
  }>
}

/**
 * Uma entrada por mensagem das changes cujo canal validou a assinatura. Mesma regra do caminho inline:
 * só changes com `messages` E `contacts`; contato = contacts[i] ?? contacts[0]. Conta/canal vêm do canal
 * verificado, nunca do corpo.
 */
export function extractMessageEvents(
  body: BodyLike,
  verifiedChannels: ReadonlyMap<string, { id: string; account_id: string }>,
  channelKeyOf: (entry: { id?: string }, change: { field?: string; value?: { metadata?: { phone_number_id?: string } } }) => string | null,
): MessageEventInput[] {
  const events: MessageEventInput[] = []
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value
      if (!value?.messages || !value.contacts) continue
      const key = channelKeyOf(entry, change)
      const channel = key ? verifiedChannels.get(key) : undefined
      const phoneNumberId = value.metadata?.phone_number_id
      if (!channel || !phoneNumberId) continue
      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        if (!message?.id) continue
        const ts = Number(message.timestamp)
        events.push({
          provider: 'meta',
          account_id: channel.account_id,
          channel_id: channel.id,
          message_id: message.id,
          sender: String(message.from ?? ''),
          ts: Number.isFinite(ts) && ts > 0 ? ts : null,
          payload: { message, contact: value.contacts[i] ?? value.contacts[0], phone_number_id: phoneNumberId },
        })
      }
    }
  }
  return events
}

type RpcError = { code?: string; message?: string } | null
type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }>
export type InboxDb = { rpc: Rpc }

function isMissingFunction(error: RpcError): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883' || /could not find the function|does not exist/i.test(error?.message ?? '')
}

// Migration 201 ausente: não insiste a cada POST; confere de novo depois de 60 s (sem restart).
const MISSING_RECHECK_MS = 60_000
let missingUntil = 0

/** Só para testes. */
export function resetMessageInboxState(): void {
  missingUntil = 0
}

export type IngestMessagesResult =
  | { ok: true; inserted: number; ids: number[] }
  | { ok: false; missing: true }
  | { ok: false; missing: false; error: string }

/** Grava o lote (1 chamada). `state`: 'pending' (modo on) ou 'shadow'. `missing` = migration 201 ausente. */
export async function ingestMessageEvents(
  db: InboxDb,
  events: readonly MessageEventInput[],
  state: 'pending' | 'shadow',
  now: number = Date.now(),
): Promise<IngestMessagesResult> {
  if (events.length === 0) return { ok: true, inserted: 0, ids: [] }
  if (now < missingUntil) return { ok: false, missing: true }
  const { data, error } = await db.rpc('ingest_message_events', { p_events: events, p_state: state })
  if (error) {
    if (isMissingFunction(error)) {
      missingUntil = now + MISSING_RECHECK_MS
      return { ok: false, missing: true }
    }
    return { ok: false, missing: false, error: error.message ?? 'erro desconhecido' }
  }
  const result = (data ?? {}) as { inserted?: number; ids?: unknown }
  const ids = Array.isArray(result.ids) ? result.ids.map(Number).filter(Number.isFinite) : []
  return { ok: true, inserted: Number(result.inserted ?? ids.length), ids }
}

/** Linha reservada pelo claim (campos usados pelo processador). */
export interface InboxRow {
  id: number
  account_id: string
  channel_id: string
  message_id: string
  payload: { message: unknown; contact: unknown; phone_number_id: string }
  attempts: number
}

export type RowOutcome = 'processed' | 'duplicate' | 'reaction'

export interface DrainMessageOptions {
  /** Processa UMA mensagem (lança em caso de falha). */
  process: (row: InboxRow) => Promise<RowOutcome>
  /** after() do webhook: reserva primeiro as PRÓPRIAS mensagens, sem esperar a vez. */
  ids?: number[]
  /** Depois das próprias, só drena o resto se ganhar a vez (~1×/s no cluster). Cron: false. */
  requireTurn?: boolean
  limit?: number
  maxBatches?: number
  concurrency?: number
  /** Não inicia outro lote depois disso (orçamento do tick/after). */
  shouldStop?: () => boolean
  owner?: string
  /** Chamado ao esgotar as tentativas (alerta). */
  onDead?: (row: InboxRow, error: string) => void
}

export interface DrainMessageSummary {
  claimed: number
  processed: number
  duplicates: number
  failed: number
  dead: number
  /** true se a migration 201 não está aplicada. */
  missing: boolean
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, worker))
}

/** Processa o inbox. Nunca lança. Linhas de conversas diferentes em paralelo; a mesma conversa, em ordem. */
export async function drainMessageInbox(db: InboxDb, options: DrainMessageOptions): Promise<DrainMessageSummary> {
  const summary: DrainMessageSummary = { claimed: 0, processed: 0, duplicates: 0, failed: 0, dead: 0, missing: false }
  const owner = options.owner ?? `drain-${Math.random().toString(36).slice(2, 10)}`
  const limit = options.limit ?? DEFAULT_CLAIM_LIMIT
  const maxBatches = options.maxBatches ?? 3

  const handleRow = async (row: InboxRow) => {
    try {
      const outcome = await options.process(row)
      const { error } = await db.rpc('complete_message_inbox', { p_id: row.id, p_outcome: outcome })
      if (error) throw new Error(`complete_message_inbox: ${error.message}`)
      if (outcome === 'duplicate') summary.duplicates++
      else summary.processed++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      summary.failed++
      try {
        const { data } = await db.rpc('fail_message_inbox', { p_id: row.id, p_error: message, p_max_attempts: MESSAGE_INBOX_MAX_ATTEMPTS })
        if (data === 'dead') {
          summary.dead++
          options.onDead?.(row, message)
        }
      } catch (failError) {
        console.error('[message-inbox] fail_message_inbox falhou:', failError instanceof Error ? failError.message : failError)
      }
    }
  }

  const claim = async (ids?: number[]): Promise<InboxRow[] | null> => {
    const { data, error } = await db.rpc('claim_message_inbox', {
      p_owner: owner,
      p_limit: limit,
      p_lease_seconds: LEASE_SECONDS,
      p_ids: ids ?? null,
    })
    if (error) {
      if (isMissingFunction(error)) summary.missing = true
      else console.error('[message-inbox] falha ao reservar o lote:', error.message)
      return null
    }
    return Array.isArray(data) ? (data as InboxRow[]) : []
  }

  try {
    // 1) As próprias mensagens do POST (sem esperar a vez): latência igual à do caminho antigo.
    if (options.ids && options.ids.length > 0) {
      const rows = await claim(options.ids)
      if (rows && rows.length > 0) {
        summary.claimed += rows.length
        await runPool(rows, options.concurrency ?? DEFAULT_CONCURRENCY, handleRow)
      }
      if (rows === null) return summary
    }
    // 2) Backlog: no webhook só com a vez; no cron, sempre.
    if (options.requireTurn) {
      const { data, error } = await db.rpc('try_claim_message_drain', { p_interval_ms: DRAIN_TURN_MS })
      if (error) {
        summary.missing = isMissingFunction(error)
        return summary
      }
      if (data !== true) return summary
    }
    for (let i = 0; i < maxBatches; i++) {
      if (options.shouldStop?.()) break
      const rows = await claim()
      if (!rows || rows.length === 0) break
      summary.claimed += rows.length
      await runPool(rows, options.concurrency ?? DEFAULT_CONCURRENCY, handleRow)
      if (rows.length < limit) break
    }
  } catch (error) {
    console.error('[message-inbox] falha inesperada ao drenar:', error instanceof Error ? error.message : error)
  }
  return summary
}

export interface ShadowSummary {
  matched: number
  na: number
  missing: number
  unavailable: boolean
}

/** Modo shadow: compara o inbox com `messages` (não reprocessa). Chamado pelo cron. Nunca lança. */
export async function reconcileShadowInbox(db: InboxDb, minAgeSeconds = 30, limit = 500): Promise<ShadowSummary> {
  const out: ShadowSummary = { matched: 0, na: 0, missing: 0, unavailable: false }
  try {
    const { data, error } = await db.rpc('shadow_reconcile_message_inbox', { p_min_age_seconds: minAgeSeconds, p_limit: limit })
    if (error) {
      out.unavailable = isMissingFunction(error)
      if (!out.unavailable) console.error('[message-inbox] falha no shadow_reconcile:', error.message)
      return out
    }
    const r = (data ?? {}) as { matched?: number; na?: number; missing?: number }
    out.matched = Number(r.matched ?? 0)
    out.na = Number(r.na ?? 0)
    out.missing = Number(r.missing ?? 0)
  } catch (error) {
    console.error('[message-inbox] falha inesperada no shadow_reconcile:', error instanceof Error ? error.message : error)
  }
  return out
}
