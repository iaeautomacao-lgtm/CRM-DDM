// PRD 14, 14.10 — webhook social da Meta (Instagram/Messenger): teto de corpo (SW-5) e HMAC sobre o BRUTO antes do JSON.parse.
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  parse: vi.fn((body: unknown) => (body as { events?: unknown[] }).events ?? []),
  ingest: vi.fn(async () => undefined),
  afterCallbacks: [] as Array<() => Promise<void>>,
}))
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (cb: () => Promise<void>) => void mocks.afterCallbacks.push(cb) }
})
vi.mock('@/lib/audit/context', () => ({ registerAuditActor: async () => undefined }))
vi.mock('@/lib/channels/inbound', () => ({ parseSocialWebhook: (b: unknown) => mocks.parse(b) }))
vi.mock('@/lib/channels/ingest', () => ({ ingestSocialEvent: mocks.ingest }))

import { POST } from './route'

const META = 'segredo-do-app-facebook'
const INSTA = 'segredo-do-app-instagram'

const sign = (raw: string, secret: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')
const post = (raw: string, signature?: string | null) =>
  new Request('http://localhost/api/meta/webhook', {
    method: 'POST',
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    body: raw,
  })

beforeEach(() => {
  vi.stubEnv('META_APP_SECRET', META)
  vi.stubEnv('INSTAGRAM_APP_SECRET', INSTA)
  mocks.parse.mockClear()
  mocks.ingest.mockClear()
  mocks.afterCallbacks.length = 0
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/meta/webhook — HMAC antes do parse e teto de corpo', () => {
  it('sem assinatura ou com assinatura malformada: 401 ANTES do parse (corpo inválido não vira 400)', async () => {
    for (const signature of [null, 'lixo', 'sha256=curta', 'sha256=' + 'z'.repeat(64)]) {
      const res = await POST(post('isto não é json', signature))
      expect(res.status, String(signature)).toBe(401)
    }
    expect(mocks.parse).not.toHaveBeenCalled()
  })

  it('assinatura bem formada mas de outro segredo: 401 sem parsear', async () => {
    const raw = JSON.stringify({ object: 'page', events: [] })
    expect((await POST(post(raw, sign(raw, 'segredo-de-atacante')))).status).toBe(401)
    expect(mocks.parse).not.toHaveBeenCalled()
  })

  it('assinatura válida com JSON inválido: 400', async () => {
    const raw = '{"object": "page", '
    expect((await POST(post(raw, sign(raw, META)))).status).toBe(400)
  })

  it('Messenger (object=page) assina com o segredo do app; Instagram com o do Instagram (ou o do app se não houver)', async () => {
    const page = JSON.stringify({ object: 'page', events: [{ type: 'message', mid: 'm1' }] })
    expect((await POST(post(page, sign(page, META)))).status).toBe(200)

    const insta = JSON.stringify({ object: 'instagram', events: [{ type: 'message', mid: 'm2' }] })
    expect((await POST(post(insta, sign(insta, INSTA)))).status).toBe(200)
    expect(mocks.parse).toHaveBeenCalledTimes(2)
  })

  it('o segredo do Instagram NÃO vale para um evento Messenger (mesma regra de antes do endurecimento)', async () => {
    const page = JSON.stringify({ object: 'page', events: [{ type: 'message', mid: 'm3' }] })
    const res = await POST(post(page, sign(page, INSTA)))
    expect(res.status).toBe(401)
    expect(mocks.parse).not.toHaveBeenCalled()
  })

  it('sem nenhum segredo configurado: nada é aceito', async () => {
    vi.stubEnv('META_APP_SECRET', '')
    vi.stubEnv('INSTAGRAM_APP_SECRET', '')
    const raw = JSON.stringify({ object: 'page' })
    expect((await POST(post(raw, sign(raw, META)))).status).toBe(401)
  })

  it('corpo acima de 1 MB: 413 (declarado ou em stream), sem verificar nem parsear', async () => {
    const big = 'a'.repeat(1_100_000)
    expect((await POST(post(big, sign(big, META)))).status).toBe(413)
    const declared = new Request('http://localhost/api/meta/webhook', {
      method: 'POST',
      headers: { 'content-length': String(5 * 1024 * 1024), 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) },
      body: 'x',
    })
    expect((await POST(declared)).status).toBe(413)
    expect(mocks.parse).not.toHaveBeenCalled()
  })

  it('evento válido: responde 200 com a contagem e processa depois (after)', async () => {
    const raw = JSON.stringify({ object: 'page', events: [{ type: 'message', mid: 'a' }, { type: 'message', mid: 'b' }] })
    const res = await POST(post(raw, sign(raw, META)))
    expect(await res.json()).toEqual({ received: 2 })
    expect(mocks.ingest).not.toHaveBeenCalled()
    for (const cb of mocks.afterCallbacks) await cb()
    expect(mocks.ingest).toHaveBeenCalledTimes(2)
  })
})
