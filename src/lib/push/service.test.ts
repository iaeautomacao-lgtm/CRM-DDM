import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (t: string) => `enc(${t})`, decrypt: (t: string) => t.replace(/^enc\(|\)$/g, '') }))

import { deleteSubscription, drainPushOutbox, getOrCreateVapidPublicKey, parseSubscription, PUSH_PAYLOAD_TYPE, saveSubscription } from './service'
import { generateVapidKeys } from './web-push'

type Row = Record<string, any>

function fakeDb(seed: Record<string, Row[]>, outbox: Row[] = []) {
  const tables: Record<string, Row[]> = { push_vapid_keys: [], push_subscriptions: [], team_members: [], ...seed }
  const db = {
    rpc: async (name: string) => (name === 'claim_push_outbox' ? { data: outbox, error: null } : { data: null, error: { code: 'PGRST202' } }),
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = [])
      let op: 'select' | 'insert' | 'upsert' | 'delete' = 'select'
      let payload: Row = {}
      const filters: Array<(r: Row) => boolean> = []
      const b: Record<string, any> = {}
      b.select = () => b
      b.insert = (p: Row) => ((op = 'insert'), (payload = p), b)
      b.upsert = (p: Row) => ((op = 'upsert'), (payload = p), b)
      b.delete = () => ((op = 'delete'), b)
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b)
      b.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b)
      b.limit = () => b
      b.then = (resolve: (v: unknown) => void) => {
        const match = rows.filter((r) => filters.every((f) => f(r)))
        if (op === 'insert') return (rows.push({ ...payload }), resolve({ error: null }))
        if (op === 'upsert') {
          const i = rows.findIndex((r) => r.endpoint === payload.endpoint)
          if (i >= 0) rows[i] = { ...rows[i], ...payload }
          else rows.push({ ...payload })
          return resolve({ error: null })
        }
        if (op === 'delete') {
          tables[table] = rows.filter((r) => !match.includes(r))
          return resolve({ error: null })
        }
        return resolve({ data: match, error: null })
      }
      return b
    },
  }
  return { db: db as never, tables }
}

const validKeys = () => ({ p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') })
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abcdefghijklmnop'

describe('parseSubscription', () => {
  it('aceita o PushSubscription.toJSON() válido', () => {
    expect(parseSubscription({ endpoint: ENDPOINT, keys: validKeys() })).toMatchObject({ endpoint: ENDPOINT })
  })
  it('recusa endpoint fora da lista, chaves ausentes ou de tamanho errado', () => {
    expect(parseSubscription({ endpoint: 'https://intranet.local/x', keys: validKeys() })).toBeNull()
    expect(parseSubscription({ endpoint: ENDPOINT, keys: { p256dh: 'AAAA', auth: validKeys().auth } })).toBeNull()
    expect(parseSubscription({ endpoint: ENDPOINT, keys: { p256dh: validKeys().p256dh, auth: 'x' } })).toBeNull()
    expect(parseSubscription({ endpoint: ENDPOINT })).toBeNull()
    expect(parseSubscription(null)).toBeNull()
  })
})

describe('chave VAPID por conta', () => {
  it('cria o par na 1ª vez (privada CIFRADA) e devolve sempre a mesma pública', async () => {
    const { db, tables } = fakeDb({})
    const a = await getOrCreateVapidPublicKey(db, 'acc')
    const b = await getOrCreateVapidPublicKey(db, 'acc')
    expect(a).toBe(b)
    expect(tables.push_vapid_keys).toHaveLength(1)
    expect(tables.push_vapid_keys[0].private_key_enc).toMatch(/^enc\(-----BEGIN PRIVATE KEY-----/)
    expect(Buffer.from(a, 'base64url')).toHaveLength(65)
  })
})

describe('inscrições', () => {
  it('grava, reaponta ao usuário atual (mesmo endpoint) e só apaga a própria', async () => {
    const { db, tables } = fakeDb({})
    const sub = { endpoint: ENDPOINT, ...validKeys() }
    await saveSubscription(db, { accountId: 'acc', userId: 'u1', sub, userAgent: 'UA' })
    await saveSubscription(db, { accountId: 'acc', userId: 'u2', sub, userAgent: 'UA' })
    expect(tables.push_subscriptions).toHaveLength(1)
    expect(tables.push_subscriptions[0].user_id).toBe('u2')
    await deleteSubscription(db, { accountId: 'acc', userId: 'u1', endpoint: ENDPOINT })
    expect(tables.push_subscriptions).toHaveLength(1)
    await deleteSubscription(db, { accountId: 'acc', userId: 'u2', endpoint: ENDPOINT })
    expect(tables.push_subscriptions).toHaveLength(0)
  })
})

describe('drainPushOutbox', () => {
  const vapid = generateVapidKeys()
  const seed = () => ({
    push_vapid_keys: [{ account_id: 'acc', public_key: vapid.publicKey, private_key_enc: `enc(${vapid.privateKeyPem})` }],
    team_members: [{ team_id: 't1', user_id: 'u1' }, { team_id: 't1', user_id: 'u2' }, { team_id: 't2', user_id: 'u3' }],
    push_subscriptions: [
      { account_id: 'acc', user_id: 'u1', endpoint: `${ENDPOINT}1`, ...validKeys() },
      { account_id: 'acc', user_id: 'u2', endpoint: `${ENDPOINT}2`, ...validKeys() },
      { account_id: 'acc', user_id: 'u3', endpoint: `${ENDPOINT}3`, ...validKeys() }, // outra equipe
    ],
  })
  const row = (over: Row = {}) => ({ id: 'o1', account_id: 'acc', conversation_id: 'conv-1', team_id: 't1', ...over })

  it('avisa só os membros da equipe da conversa, com payload de tipo + id (sem texto nem dado pessoal)', async () => {
    const { db } = fakeDb(seed(), [row()])
    const sender = vi.fn(async (_sub: { endpoint: string }, _payload: unknown) => ({ status: 201, gone: false }))
    const r = await drainPushOutbox(db, { sender: sender as never })
    expect(r).toMatchObject({ claimed: 1, sent: 2, failed: 0 })
    expect(sender.mock.calls.map((c) => c[0].endpoint).sort()).toEqual([`${ENDPOINT}1`, `${ENDPOINT}2`])
    for (const c of sender.mock.calls) expect(c[1]).toEqual({ type: PUSH_PAYLOAD_TYPE, conversation_id: 'conv-1' })
  })

  it('404/410 remove a inscrição; erro de envio só conta como falha (não lança)', async () => {
    const { db, tables } = fakeDb(seed(), [row()])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sender = vi.fn(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('1')) return { status: 410, gone: true }
      throw new Error('rede')
    })
    const r = await drainPushOutbox(db, { sender: sender as never })
    expect(r).toMatchObject({ sent: 0, removed: 1, failed: 1 })
    expect(tables.push_subscriptions.map((s) => s.endpoint).sort()).toEqual([`${ENDPOINT}2`, `${ENDPOINT}3`])
  })

  it('conversa sem equipe não notifica ninguém; sem a migration (RPC ausente) é no-op', async () => {
    const sender = vi.fn(async () => ({ status: 201, gone: false }))
    expect(await drainPushOutbox(fakeDb(seed(), [row({ team_id: null })]).db, { sender: sender as never })).toMatchObject({ claimed: 1, sent: 0 })
    expect(sender).not.toHaveBeenCalled()
    const noMigration = { rpc: async () => ({ data: null, error: { code: '42883' } }) } as never
    expect(await drainPushOutbox(noMigration, { sender: sender as never })).toEqual({ claimed: 0, sent: 0, removed: 0, failed: 0 })
  })
})
