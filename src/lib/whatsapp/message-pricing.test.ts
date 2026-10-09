import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractPricingEvents, loadCostSummary, recordMessagePricing, summarizeCost } from './message-pricing'

const channels = new Map([['pn:111', { id: 'ch-1', account_id: 'acc-1' }]])
const keyOf = (_e: unknown, change: { value?: { metadata?: { phone_number_id?: string } } }) =>
  change.value?.metadata?.phone_number_id ? `pn:${change.value.metadata.phone_number_id}` : null

const body = (statuses: unknown[], phone = '111') => ({
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, statuses } }] }],
})

afterEach(() => vi.restoreAllMocks())

describe('extractPricingEvents', () => {
  it('extrai categoria/cobrável de qualquer status com pricing (inclusive sent) e escopa pela conta do canal verificado', () => {
    const events = extractPricingEvents(
      body([
        { id: 'wamid.1', status: 'sent', timestamp: '1760000000', pricing: { billable: true, pricing_model: 'PMP', category: 'Marketing', type: 'regular' } },
        { id: 'wamid.2', status: 'delivered', timestamp: '1760000001', pricing: { billable: false, pricing_model: 'PMP', category: 'service', type: 'free_customer_service' } },
        { id: 'wamid.3', status: 'read', timestamp: '1760000002' }, // sem pricing: ignorado
      ]) as never,
      channels,
      keyOf as never,
    )
    expect(events).toEqual([
      { message_id: 'wamid.1', account_id: 'acc-1', channel_id: 'ch-1', category: 'marketing', pricing_type: 'regular', pricing_model: 'PMP', billable: true, ts: 1760000000 },
      { message_id: 'wamid.2', account_id: 'acc-1', channel_id: 'ch-1', category: 'service', pricing_type: 'free_customer_service', pricing_model: 'PMP', billable: false, ts: 1760000001 },
    ])
  })

  it('canal não verificado (assinatura não validou) não gera evento; categoria ausente vira unknown e billable só é true se for true', () => {
    expect(extractPricingEvents(body([{ id: 'w', pricing: { billable: true, category: 'utility' } }], '999') as never, channels, keyOf as never)).toEqual([])
    const [e] = extractPricingEvents(body([{ id: 'w', pricing: { billable: 'true' } }]) as never, channels, keyOf as never)
    expect(e).toMatchObject({ category: 'unknown', billable: false, ts: null })
  })
})

describe('recordMessagePricing', () => {
  const ev = [{ message_id: 'w', account_id: 'a', channel_id: 'c', category: 'utility', pricing_type: null, pricing_model: null, billable: true, ts: null }]

  it('1 chamada para o lote e devolve o que entrou', async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }))
    expect(await recordMessagePricing({ rpc }, ev)).toBe(1)
    expect(rpc).toHaveBeenCalledWith('record_message_pricing', { p_events: ev })
    expect(await recordMessagePricing({ rpc }, [])).toBe(0)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('migration ausente é silenciosa; outro erro é registrado; nunca lança', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await recordMessagePricing({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) }, ev)).toBe(0)
    expect(log).not.toHaveBeenCalled()
    expect(await recordMessagePricing({ rpc: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) }, ev)).toBe(0)
    expect(await recordMessagePricing({ rpc: async () => { throw new Error('rede') } }, ev)).toBe(0)
    expect(log).toHaveBeenCalledTimes(2)
  })
})

describe('summarizeCost / loadCostSummary', () => {
  const rows = [
    { campaign_id: 'c1', channel_id: 'n1', category: 'marketing', billable: true, messages: 100 },
    { campaign_id: 'c1', channel_id: 'n2', category: 'marketing', billable: true, messages: 50 },
    { campaign_id: 'c1', channel_id: 'n1', category: 'utility', billable: false, messages: 30 },
  ]

  it('soma só o cobrável por categoria e mantém o total de mensagens', () => {
    expect(summarizeCost(rows)).toMatchObject({ billableByCategory: { marketing: 150 }, totalBillable: 150, totalMessages: 180, available: true })
  })

  it('sem a migration devolve available=false; erro real lança', async () => {
    expect((await loadCostSummary({ rpc: async () => ({ data: null, error: { code: '42883' } }) }, 'a')).available).toBe(false)
    await expect(loadCostSummary({ rpc: async () => ({ data: null, error: { code: 'XX', message: 'boom' } }) }, 'a')).rejects.toThrow('boom')
    const rpc = vi.fn(async () => ({ data: rows, error: null }))
    expect((await loadCostSummary({ rpc }, 'a', { campaignId: 'c1' })).totalBillable).toBe(150)
    expect(rpc).toHaveBeenCalledWith('dispatch_cost_summary', { p_account_id: 'a', p_campaign_id: 'c1', p_since: null, p_limit: 500 })
  })
})
