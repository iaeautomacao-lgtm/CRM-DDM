import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/disparador/send-ledger', () => ({
  runIdempotentSend: (_account: string, _request: Request, work: () => Promise<Response>) => work(),
}));

// ---------------------------------------------------------------------------
// Tests for the `contact_id` send path (issue #296): sending an approved
// template to a single contact from the Contact detail view. The route must
// find-or-create the contact's conversation server-side, then run the normal
// send + persistence path — no inbound message required to bootstrap a thread.
// ---------------------------------------------------------------------------

// Records of what the route wrote, so we can assert the right rows landed.
const conversationInserts: Array<Record<string, unknown>> = []
const messageInserts: Array<Record<string, unknown>> = []

// Toggles for the per-test scenario.
let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
let messageInsertError: { message: string } | null = null
// Linhas que o operador enxerga (RLS, cliente de sessão) e a linha completa lida pelo service role.
let sessionLines: Array<{ id: string }> = [{ id: 'cfg-1' }]
let adminLine: Record<string, unknown> = {}

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  phone: '+15551234567',
}

// Chainable Supabase mock. A fresh builder per `.from()` call tracks whether
// `.insert()` ran so the terminal resolves to the inserted row for creates
// and the canned select row otherwise.
function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false

    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1', account_role: 'agent' }, error: null }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Conta' }, error: null }
        case 'contacts':
          return { data: contactRow, error: null }
        case 'conversations':
          return { data: existingConversation, error: null }
        case 'whatsapp_config':
          // Migration 200b: o cliente de sessão só enxerga os ids (RLS); os
          // segredos vêm do service role (mock abaixo).
          return { data: sessionLines, error: null }
        case 'message_templates':
          return { data: null, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      switch (table) {
        case 'conversations':
          return {
            data: {
              id: 'conv-new',
              account_id: 'acct-1',
              contact_id: 'contact-1',
              contact: CONTACT,
            },
            error: null,
          }
        case 'messages':
          return {
            data: messageInsertError ? null : { id: 'msg-1' },
            error: messageInsertError,
          }
        default:
          return { data: null, error: null }
      }
    }

    const terminal = () =>
      Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of [
      'select',
      'eq',
      'in',
      'order',
      'limit',
      'update',
      'delete',
      'is',
    ]) {
      b[m] = vi.fn(chain)
    }
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'conversations') conversationInserts.push(payload)
      if (table === 'messages') messageInserts.push(payload)
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['update', 'eq', 'select', 'in']) b[m] = vi.fn(chain)
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          table === 'whatsapp_config'
            ? {
                data: [
                  {
                    id: 'cfg-1',
                    account_id: 'acct-1',
                    phone_number_id: 'PNID-1',
                    access_token: 'enc-token',
                    ...adminLine,
                  },
                ],
                error: null,
              }
            : { data: null, error: null }
        )
      return b
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}))

const { sendWahaTextMessage } = vi.hoisted(() => ({ sendWahaTextMessage: vi.fn(async () => ({ messageId: 'waha-1' })) }))
vi.mock('@/lib/whatsapp/waha-api', () => ({ sendWahaTextMessage, sendWahaMediaMessage: vi.fn() }))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    })
  )
}

describe('POST /api/whatsapp/send — contact_id template path', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = null
    contactRow = CONTACT
    messageInsertError = null
    sessionLines = [{ id: 'cfg-1' }]
    adminLine = {}
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reports provider acceptance instead of a retryable send failure when the database fails', async () => {
    messageInsertError = { message: 'database unavailable' }
    const response = await postContactTemplate()
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      success: true,
      saved: false,
      reconciliation_required: true,
      whatsapp_message_id: 'wamid-1',
    })
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')

    // A conversation was created for this contact.
    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
    })

    // The template was sent to the contact's number.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const args = (sendTemplateMessage.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    // Meta wants the bare E.164 digits — sanitizePhoneForMeta strips the '+'.
    expect(args.to).toBe('15551234567')
    expect(args.templateName).toBe('order_update')

    // The outbound message was persisted under the new conversation.
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-new',
      content_type: 'template',
      template_name: 'order_update',
      sender_type: 'agent',
      sender_id: 'user-1',
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-existing',
    })
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contato não encontrado/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
      })
    )
    expect(res.status).toBe(400)
  })
})

// PRD 23 (item 7): o operador escolhe a linha ao iniciar a conversa (channel_id).
describe('POST /api/whatsapp/send — linha escolhida (channel_id)', () => {
  const LINE = '11111111-2222-4333-8444-555555555555'
  const postText = (overrides: Record<string, unknown>) =>
    POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'text', content_text: 'oi', ...overrides }),
      })
    )

  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = null
    contactRow = CONTACT
    messageInsertError = null
    sessionLines = [{ id: LINE }]
    adminLine = { id: LINE, provider: 'meta', habilitado: true, waha_session: null }
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  it('linha Meta escolhida: a conversa nasce vinculada a ela (config_id) e o envio segue o ramo Meta', async () => {
    const res = await postContactTemplate({ channel_id: LINE })
    expect(res.status).toBe(200)
    expect(conversationInserts[0]).toMatchObject({ account_id: 'acct-1', contact_id: 'contact-1', config_id: LINE })
    expect(conversationInserts[0]).not.toHaveProperty('waha_session')
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })

  it('linha WAHA escolhida: a conversa usa a SESSÃO da linha (nunca config_id) — Meta e WAHA não se misturam', async () => {
    adminLine = { id: LINE, provider: 'waha', habilitado: true, waha_session: 'sessao-7' }
    await postText({ contact_id: 'contact-1', channel_id: LINE })
    expect(conversationInserts[0]).toMatchObject({ waha_session: 'sessao-7' })
    expect(conversationInserts[0]).not.toHaveProperty('config_id')
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(sendWahaTextMessage).toHaveBeenCalledTimes(1)
  })

  it('linha que o operador NÃO enxerga (outra equipe/conta) = 404 e nada é criado nem enviado', async () => {
    sessionLines = []
    const res = await postContactTemplate({ channel_id: LINE })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'line_not_found' })
    expect(conversationInserts).toHaveLength(0)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('linha desabilitada = 409; channel_id que não é uuid = 400', async () => {
    adminLine = { id: LINE, provider: 'meta', habilitado: false }
    const disabled = await postContactTemplate({ channel_id: LINE })
    expect(disabled.status).toBe(409)
    expect(await disabled.json()).toMatchObject({ code: 'line_disabled' })
    const bad = await postContactTemplate({ channel_id: "'; drop table" })
    expect(bad.status).toBe(400)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('conversa existente de OUTRA linha = 409 line_mismatch (não troca a linha de uma conversa); a mesma linha passa', async () => {
    existingConversation = { id: 'conv-x', account_id: 'acct-1', contact_id: 'contact-1', contact: CONTACT, config_id: 'outra-linha' }
    const mismatch = await postContactTemplate({ contact_id: undefined, conversation_id: 'conv-x', channel_id: LINE })
    expect(mismatch.status).toBe(409)
    expect(await mismatch.json()).toMatchObject({ code: 'line_mismatch' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()

    existingConversation = { id: 'conv-x', account_id: 'acct-1', contact_id: 'contact-1', contact: CONTACT, config_id: LINE }
    const same = await postContactTemplate({ contact_id: undefined, conversation_id: 'conv-x', channel_id: LINE })
    expect(same.status).toBe(200)
  })

  it('sem channel_id o comportamento de antes não muda', async () => {
    const res = await postContactTemplate()
    expect(res.status).toBe(200)
    expect(conversationInserts[0]).not.toHaveProperty('config_id')
  })
})
