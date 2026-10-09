// Custo Meta por envio (migration 195). O webhook de status traz `statuses[].pricing = { billable, pricing_model, category, type }`
// (em sent/delivered/read, conforme a versão da API); aqui só se extrai e grava — a conta vem do canal que validou a assinatura.
// Best-effort: roda em after() do webhook e NUNCA lança nem muda a resposta ao webhook; sem a migration, é no-op.

export interface PricingEventInput {
  message_id: string
  account_id: string
  channel_id: string
  category: string
  pricing_type: string | null
  pricing_model: string | null
  billable: boolean
  /** Segundos desde epoch (campo `timestamp` da Meta). */
  ts: number | null
}

interface MetaPricingStatus {
  id?: string
  timestamp?: string
  pricing?: { billable?: unknown; pricing_model?: unknown; category?: unknown; type?: unknown }
}

interface BodyLike {
  entry?: Array<{
    id?: string
    changes?: Array<{ field?: string; value?: { metadata?: { phone_number_id?: string }; statuses?: MetaPricingStatus[] } }>
  }>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null)

/** Pricing de TODOS os statuses (sent/delivered/read/failed) dos canais que validaram a assinatura. Sem `pricing` ⇒ ignorado. */
export function extractPricingEvents(
  body: BodyLike,
  verifiedChannels: ReadonlyMap<string, { id: string; account_id: string }>,
  channelKeyOf: (entry: { id?: string }, change: { field?: string; value?: { metadata?: { phone_number_id?: string } } }) => string | null,
): PricingEventInput[] {
  const events: PricingEventInput[] = []
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const key = channelKeyOf(entry, change)
      const channel = key ? verifiedChannels.get(key) : undefined
      if (!channel) continue
      for (const status of change.value?.statuses ?? []) {
        const pricing = status?.pricing
        if (!status?.id || !pricing || typeof pricing !== 'object') continue
        const ts = Number(status.timestamp)
        events.push({
          message_id: status.id,
          account_id: channel.account_id,
          channel_id: channel.id,
          category: str(pricing.category)?.toLowerCase() ?? 'unknown',
          pricing_type: str(pricing.type),
          pricing_model: str(pricing.pricing_model),
          billable: pricing.billable === true,
          ts: Number.isFinite(ts) && ts > 0 ? ts : null,
        })
      }
    }
  }
  return events
}

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
type Db = { rpc: (fn: string, args?: Record<string, unknown>) => RpcResult }

function isMissing(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883' || error?.code === '42P01'
}

/** Grava o lote (1 chamada). Devolve quantas linhas novas entraram; qualquer erro (inclusive migration ausente) vira 0 e é só registrado. */
export async function recordMessagePricing(db: Db, events: readonly PricingEventInput[]): Promise<number> {
  if (events.length === 0) return 0
  try {
    const { data, error } = await db.rpc('record_message_pricing', { p_events: events })
    if (error) {
      if (!isMissing(error)) console.error('[webhook] falha ao gravar o pricing da Meta:', error.message)
      return 0
    }
    return typeof data === 'number' ? data : 0
  } catch (e) {
    console.error('[webhook] falha ao gravar o pricing da Meta:', e instanceof Error ? e.message : e)
    return 0
  }
}

export interface CostRow {
  campaign_id: string
  channel_id: string | null
  category: string
  billable: boolean
  messages: number
}

export interface CostSummary {
  rows: CostRow[]
  /** Mensagens COBRÁVEIS por categoria (todas as campanhas/números do resultado). */
  billableByCategory: Record<string, number>
  totalBillable: number
  totalMessages: number
  /** false = migration 195 ausente (sem dados de custo). */
  available: boolean
}

export function summarizeCost(rows: readonly CostRow[]): CostSummary {
  const billableByCategory: Record<string, number> = {}
  let totalBillable = 0
  let totalMessages = 0
  for (const r of rows) {
    totalMessages += r.messages
    if (!r.billable) continue
    totalBillable += r.messages
    billableByCategory[r.category] = (billableByCategory[r.category] ?? 0) + r.messages
  }
  return { rows: [...rows], billableByCategory, totalBillable, totalMessages, available: true }
}

/** Soma do custo por campanha × número × categoria (dispatch_cost_summary). Sem a migration ⇒ `available: false`. */
export async function loadCostSummary(
  db: Db,
  accountId: string,
  opts: { campaignId?: string | null; since?: string | null; limit?: number } = {},
): Promise<CostSummary> {
  const { data, error } = await db.rpc('dispatch_cost_summary', {
    p_account_id: accountId,
    p_campaign_id: opts.campaignId ?? null,
    p_since: opts.since ?? null,
    p_limit: opts.limit ?? 500,
  })
  if (error) {
    if (isMissing(error)) return { rows: [], billableByCategory: {}, totalBillable: 0, totalMessages: 0, available: false }
    throw new Error(error.message ?? 'falha ao somar o custo')
  }
  return summarizeCost(Array.isArray(data) ? (data as CostRow[]) : [])
}
