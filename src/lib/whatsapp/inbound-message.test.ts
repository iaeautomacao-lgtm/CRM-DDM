// PRD 15 — processMessage: WH-21 (dedupe barato antes do trabalho pesado) e WH-03 (contato/perfil ausente não derruba).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ table: string; op: string; payload?: unknown }> = []
const uploadedPaths: string[] = []
let storedWamids = new Set<string>()
const getMediaUrl = vi.fn(async () => ({ url: 'https://cdn.example/x', mimeType: 'image/jpeg' }))
const downloadMedia = vi.fn(async () => ({ buffer: new ArrayBuffer(8), contentType: 'image/jpeg' }))
const findExistingContact = vi.fn()
const dispatchInboundToFlows = vi.fn(async () => ({ consumed: true }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploadedPaths.push(path)
          return { error: null }
        },
      }),
    },
    from: (table: string) => {
      let head = false
      let wamid: string | null = null
      let op = 'select'
      const b: Record<string, unknown> = {}
      for (const m of ['order', 'neq', 'is', 'in']) b[m] = () => b
      b.select = (_c: string, opts?: { head?: boolean }) => {
        head = Boolean(opts?.head)
        return b
      }
      b.eq = (c: string, v: unknown) => {
        if (table === 'messages' && c === 'message_id') wamid = String(v)
        return b
      }
      b.insert = (payload: unknown) => ((op = 'insert'), calls.push({ table, op, payload }), b)
      b.update = (payload: unknown) => ((op = 'update'), calls.push({ table, op, payload }), b)
      b.single = async () => ({ data: { id: 'new-row' }, error: null })
      b.maybeSingle = async () => ({ data: null, error: null })
      b.limit = () => b
      b.then = (resolve: (v: unknown) => void) => {
        if (op !== 'select') return resolve({ data: null, error: null })
        calls.push({ table, op: head ? 'count' : 'select', payload: wamid })
        if (table === 'messages' && head) return resolve({ count: 1, error: null })
        if (table === 'messages') return resolve({ data: wamid && storedWamids.has(wamid) ? [{ id: 'm1' }] : [], error: null })
        if (table === 'conversations') return resolve({ data: [{ id: 'conv-1', status: 'open', assigned_agent_id: null }], error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))
vi.mock('@/lib/audit/context', () => ({ auditFetch: fetch }))
vi.mock('@/lib/storage/chat-media', () => ({ chatMediaReference: (p: string) => p }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: (...a: unknown[]) => (getMediaUrl as unknown as (...x: unknown[]) => unknown)(...a),
  downloadMedia: (...a: unknown[]) => (downloadMedia as unknown as (...x: unknown[]) => unknown)(...a),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: (...a: unknown[]) => findExistingContact(...a),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: async () => {} }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: (...a: unknown[]) => (dispatchInboundToFlows as unknown as (...x: unknown[]) => unknown)(...a) }))
vi.mock('@/lib/ai/sentiment-trigger', () => ({ maybeScheduleSentiment: () => {} }))
vi.mock('@/lib/disparador/reply-tracker', () => ({ recordCampaignReply: async () => {} }))
vi.mock('@/lib/webchat/campaign', () => ({ maybeStartCampaignWebchat: async () => false }))
vi.mock('@/lib/logger', () => ({ writeLog: async () => {}, maskPhone: (p: string) => p }))

const { processMessage } = await import('./inbound-message')

const text = (id: string) => ({ id, from: '5511999990001', timestamp: '1760000000', type: 'text', text: { body: 'oi' } })
const image = (id: string) => ({ id, from: '5511999990001', timestamp: '1760000000', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } })
const run = (message: unknown, contact: unknown) =>
  processMessage(message as never, contact as never, 'ACC-1', 'USER-1', 'tok', 'CFG-1')

beforeEach(() => {
  calls.length = 0
  uploadedPaths.length = 0
  storedWamids = new Set()
  getMediaUrl.mockClear()
  downloadMedia.mockClear()
  dispatchInboundToFlows.mockClear()
  findExistingContact.mockReset()
  findExistingContact.mockResolvedValue({ id: 'contact-1', name: 'Fulano' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('WH-21: wamid já gravado vira duplicata antes do trabalho pesado', () => {
  it('não baixa mídia, não toca em contato/conversa, não dispara fluxo', async () => {
    storedWamids.add('wamid.dup')
    expect(await run(image('wamid.dup'), { profile: { name: 'Fulano' }, wa_id: '5511999990001' })).toBe('duplicate')
    expect(getMediaUrl).not.toHaveBeenCalled()
    expect(downloadMedia).not.toHaveBeenCalled()
    expect(findExistingContact).not.toHaveBeenCalled()
    expect(dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(calls.map((c) => c.table)).toEqual(['messages'])
  })

  it('wamid novo segue o caminho normal e grava mídia na pasta da conta', async () => {
    expect(await run(image('wamid.new'), { profile: { name: 'Fulano' }, wa_id: '5511999990001' })).toBe('processed')
    expect(getMediaUrl).toHaveBeenCalled()
    expect(uploadedPaths).toEqual(['account-ACC-1/meta/media-1.jpg'])
    expect(calls.some((c) => c.table === 'messages' && c.op === 'insert')).toBe(true)
  })

  it('reação não passa pelo dedupe (o wamid dela nunca está em messages)', async () => {
    const reaction = { id: 'wamid.react', from: '5511999990001', timestamp: '1760000000', type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } }
    expect(await run(reaction, { profile: { name: 'Fulano' }, wa_id: '5511999990001' })).toBe('reaction')
    // nenhuma consulta de dedupe por message_id = wamid.react
    expect(calls.some((c) => c.table === 'messages' && c.payload === 'wamid.react')).toBe(false)
  })
})

describe('WH-03/04: contato ausente ou sem perfil não derruba a mensagem', () => {
  it.each([
    ['null (nenhum wa_id correspondente)', null],
    ['undefined', undefined],
    ['sem profile', { wa_id: '5511999990001' }],
    ['profile sem name', { profile: {}, wa_id: '5511999990001' }],
  ])('%s', async (_n, contact) => {
    expect(await run(text('wamid.t1'), contact)).toBe('processed')
    // contato existente não é renomeado com string vazia
    expect(calls.some((c) => c.table === 'contacts' && c.op === 'update')).toBe(false)
  })

  it('contato novo sem nome usa o telefone como nome', async () => {
    findExistingContact.mockResolvedValue(null)
    expect(await run(text('wamid.t2'), null)).toBe('processed')
    const insert = calls.find((c) => c.table === 'contacts' && c.op === 'insert')
    expect((insert?.payload as { name: string }).name).toBe('5511999990001')
  })
})

describe('WH-06: conteúdo legível de button/order/contacts/system (efeitos a jusante aceitos pelo dono)', () => {
  const base = { from: '5511999990001', timestamp: '1760000000' }
  const contactInfo = { profile: { name: 'Fulano' }, wa_id: '5511999990001' }
  const stored = (): { content_text: string | null; content_type: string } => {
    const insert = calls.find((c) => c.table === 'messages' && c.op === 'insert')
    return insert?.payload as { content_text: string | null; content_type: string }
  }

  it.each([
    ['button (texto do botão)', { id: 'w1', ...base, type: 'button', button: { text: 'Quero negociar', payload: 'p1' } }, 'Quero negociar'],
    ['button sem texto usa o payload', { id: 'w2', ...base, type: 'button', button: { payload: 'SIM' } }, 'SIM'],
    ['button vazio mantém o marcador', { id: 'w3', ...base, type: 'button' }, '[Unsupported message type: button]'],
    ['order com itens e nota', { id: 'w4', ...base, type: 'order', order: { text: 'entregar amanhã', product_items: [{ quantity: 2 }, { quantity: 1 }] } }, 'Pedido com 3 itens: entregar amanhã'],
    ['order com 1 item', { id: 'w5', ...base, type: 'order', order: { product_items: [{ quantity: 1 }] } }, 'Pedido com 1 item'],
    ['order vazio', { id: 'w6', ...base, type: 'order' }, 'Pedido'],
    ['contacts', { id: 'w7', ...base, type: 'contacts', contacts: [{ name: { formatted_name: 'Maria' }, phones: [{ phone: '+55 11 98888-0000' }] }] }, 'Contato compartilhado: Maria (+55 11 98888-0000)'],
    ['contacts vazio', { id: 'w8', ...base, type: 'contacts' }, 'Contato compartilhado'],
    ['system com body', { id: 'w9', ...base, type: 'system', system: { body: 'Cliente trocou de número', type: 'user_changed_number' } }, 'Mensagem do sistema: Cliente trocou de número'],
    ['system sem body', { id: 'w10', ...base, type: 'system' }, 'Mensagem do sistema'],
  ])('%s', async (_name, message, expected) => {
    expect(await run(message, contactInfo)).toBe('processed')
    expect(stored().content_text).toBe(expected)
    expect(stored().content_type).toBe('text')
  })

  it('o texto do botão é o que vai para o fluxo (como um texto digitado)', async () => {
    await run({ id: 'w11', ...base, type: 'button', button: { text: 'Sim' } }, contactInfo)
    expect(dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ kind: 'text', text: 'Sim' }) }),
    )
  })

  it('tipo realmente desconhecido continua como marcador', async () => {
    await run({ id: 'w12', ...base, type: 'hologram' }, contactInfo)
    expect(stored().content_text).toBe('[Unsupported message type: hologram]')
  })
})
