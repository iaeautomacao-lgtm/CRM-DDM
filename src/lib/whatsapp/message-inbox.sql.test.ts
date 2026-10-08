// Migration 201: inbox durável de mensagens da Meta. PGlite com a 201 REAL (cron_locks e messages mínimas).
// Cobre: duplicata da Meta (UNIQUE pelo wamid), queda entre o 200 e o processamento (o drenador processa depois,
// lease expirado volta à fila), ordem por conversa, backoff e `dead` após N tentativas, shadow que só compara,
// idempotência do modo on (mensagem já gravada = duplicate) — com o drenador de verdade sobre um adaptador de RPC.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  drainMessageInbox,
  extractMessageEvents,
  ingestMessageEvents,
  MESSAGE_INBOX_MAX_ATTEMPTS,
  reconcileShadowInbox,
  resetMessageInboxState,
  type InboxDb,
  type InboxRow,
} from './message-inbox'

const ACC = '00000000-0000-0000-0000-000000000001'
const CH = '00000000-0000-0000-0000-000000000021'
let db: PGlite

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')

// Adaptador: as mesmas chamadas rpc(...) do app, executadas no PGlite com a 201 real.
const SIGNATURES: Record<string, string[]> = {
  ingest_message_events: ['p_events::jsonb', 'p_state'],
  claim_message_inbox: ['p_owner', 'p_limit', 'p_lease_seconds', 'p_ids::bigint[]'],
  complete_message_inbox: ['p_id', 'p_outcome'],
  fail_message_inbox: ['p_id', 'p_error', 'p_max_attempts'],
  try_claim_message_drain: ['p_interval_ms'],
  shadow_reconcile_message_inbox: ['p_min_age_seconds', 'p_limit'],
}
const rpcDb: InboxDb = {
  rpc: async (fn, args = {}) => {
    const sig = SIGNATURES[fn]
    const names = sig.map((s) => s.split('::')[0])
    const placeholders = sig.map((s, i) => `${names[i]} => $${i + 1}${s.includes('::') ? '::' + s.split('::')[1] : ''}`)
    const values = names.map((n) => {
      const v = args[n]
      return n === 'p_events' ? JSON.stringify(v) : v === undefined ? null : v
    })
    try {
      const res = await db.query<{ r: unknown }>(`SELECT to_jsonb(x) AS r FROM (SELECT * FROM wacrm.${fn}(${placeholders.join(', ')})) x`, values)
      // Funções escalares devolvem 1 coluna com o nome da função; SETOF devolve linhas.
      if (fn === 'claim_message_inbox') return { data: res.rows.map((r) => r.r), error: null }
      const first = res.rows[0]?.r as Record<string, unknown> | undefined
      return { data: first ? first[fn] : null, error: null }
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } }
    }
  },
}

const ev = (id: string, sender = '5511999990001', ts = 1_760_000_000, type = 'text') => ({
  provider: 'meta' as const,
  account_id: ACC,
  channel_id: CH,
  message_id: id,
  sender,
  ts,
  payload: { message: { id, from: sender, type, timestamp: String(ts) }, contact: { profile: { name: 'Maria' }, wa_id: sender }, phone_number_id: 'PN1' },
})
const rows = async () =>
  (await db.query<{ message_id: string; state: string; attempts: number; outcome: string | null; last_error: string | null }>(
    'SELECT message_id, state, attempts, outcome, last_error FROM wacrm.webhook_message_inbox ORDER BY id'
  )).rows
const noop = async (): Promise<'processed'> => 'processed'

describe('migration 201 — inbox de mensagens da Meta', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.cron_locks (name text PRIMARY KEY, owner_id text, acquired_at timestamptz, expires_at timestamptz);
      CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id text);
    `)
    await db.exec(migration('201_webhook_message_inbox.sql'))
  })
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    resetMessageInboxState()
    await db.exec('TRUNCATE wacrm.webhook_message_inbox RESTART IDENTITY; TRUNCATE wacrm.cron_locks; TRUNCATE wacrm.messages;')
  })

  it('duplicata da Meta: o mesmo wamid entra uma vez só (e não volta a ser processado)', async () => {
    const first = await ingestMessageEvents(rpcDb, [ev('wamid.A'), ev('wamid.B')], 'pending')
    expect(first).toMatchObject({ ok: true, inserted: 2 })
    const dup = await ingestMessageEvents(rpcDb, [ev('wamid.A')], 'pending')
    expect(dup).toMatchObject({ ok: true, inserted: 0, ids: [] })
    expect(await rows()).toHaveLength(2)
    let calls = 0
    await drainMessageInbox(rpcDb, { process: async () => (calls++, 'processed') })
    await ingestMessageEvents(rpcDb, [ev('wamid.A')], 'pending') // reentrega depois de concluída
    await drainMessageInbox(rpcDb, { process: async () => (calls++, 'processed') })
    expect(calls).toBe(2)
  })

  it('queda entre o 200 e o processamento: a mensagem já está no banco e o drenador processa depois', async () => {
    await ingestMessageEvents(rpcDb, [ev('wamid.A')], 'pending') // 200 enviado; o processo morre aqui
    expect((await rows())[0]).toMatchObject({ state: 'pending', attempts: 0 })
    const seen: string[] = []
    const summary = await drainMessageInbox(rpcDb, { process: async (r) => (seen.push(r.message_id), 'processed') }) // cron / outro processo
    expect(seen).toEqual(['wamid.A'])
    expect(summary).toMatchObject({ claimed: 1, processed: 1, failed: 0 })
    expect((await rows())[0]).toMatchObject({ state: 'done', outcome: 'processed' })
  })

  it('processo caiu NO MEIO (lease): depois de expirar, outro drenador reserva e conclui', async () => {
    await ingestMessageEvents(rpcDb, [ev('wamid.A')], 'pending')
    await rpcDb.rpc('claim_message_inbox', { p_owner: 'morreu', p_limit: 10, p_lease_seconds: 120, p_ids: null })
    expect((await rows())[0]).toMatchObject({ state: 'processing', attempts: 1 })
    // lease ainda válido: ninguém pega
    expect((await drainMessageInbox(rpcDb, { process: noop })).claimed).toBe(0)
    await db.exec(`UPDATE wacrm.webhook_message_inbox SET lease_until = clock_timestamp() - interval '1 second'`)
    const summary = await drainMessageInbox(rpcDb, { process: noop })
    expect(summary).toMatchObject({ claimed: 1, processed: 1 })
    expect((await rows())[0]).toMatchObject({ state: 'done', attempts: 2 })
  })

  it('ordem por conversa: a segunda mensagem espera a primeira (inclusive em backoff); conversas diferentes seguem', async () => {
    await ingestMessageEvents(rpcDb, [ev('wamid.2', '5511AAA', 1_760_000_002), ev('wamid.1', '5511AAA', 1_760_000_001), ev('wamid.X', '5511BBB', 1_760_000_005)], 'pending')
    const order: string[] = []
    // 1ª tentativa de wamid.1 falha → entra em backoff; wamid.2 NÃO pode passar na frente; wamid.X (outra conversa) processa.
    const summary = await drainMessageInbox(rpcDb, {
      process: async (r: InboxRow) => {
        order.push(r.message_id)
        if (r.message_id === 'wamid.1') throw new Error('banco indisponível')
        return 'processed'
      },
    })
    expect(order.sort()).toEqual(['wamid.1', 'wamid.X'])
    expect(summary).toMatchObject({ failed: 1, processed: 1 })
    const state = Object.fromEntries((await rows()).map((r) => [r.message_id, r.state]))
    expect(state).toEqual({ 'wamid.1': 'pending', 'wamid.2': 'pending', 'wamid.X': 'done' })
    // backoff vencido → wamid.1 e depois wamid.2, nesta ordem.
    await db.exec(`UPDATE wacrm.webhook_message_inbox SET next_attempt_at = clock_timestamp() - interval '1 second'`)
    const after: string[] = []
    for (let i = 0; i < 2; i++) await drainMessageInbox(rpcDb, { process: async (r) => (after.push(r.message_id), 'processed') })
    expect(after).toEqual(['wamid.1', 'wamid.2'])
  })

  it('falha do processamento: backoff e, após N tentativas, dead (com alerta)', async () => {
    await ingestMessageEvents(rpcDb, [ev('wamid.A'), ev('wamid.B', '5511ZZZ')], 'pending')
    const dead: string[] = []
    for (let i = 0; i < MESSAGE_INBOX_MAX_ATTEMPTS; i++) {
      await db.exec(`UPDATE wacrm.webhook_message_inbox SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE state = 'pending'`)
      await drainMessageInbox(rpcDb, {
        process: async (r) => {
          if (r.message_id === 'wamid.A') throw new Error('CHECK content_type')
          return 'processed'
        },
        onDead: (r) => dead.push(r.message_id),
      })
    }
    const a = (await rows()).find((r) => r.message_id === 'wamid.A')!
    expect(a).toMatchObject({ state: 'dead', attempts: MESSAGE_INBOX_MAX_ATTEMPTS, outcome: 'dead' })
    expect(a.last_error).toContain('CHECK content_type')
    expect(dead).toEqual(['wamid.A']) // alerta uma vez só
    expect((await rows()).find((r) => r.message_id === 'wamid.B')).toMatchObject({ state: 'done' })
    // dead não bloqueia mais a conversa nem é reservada de novo
    expect((await drainMessageInbox(rpcDb, { process: noop })).claimed).toBe(0)
  })

  it('backoff cresce 30 s × 2^n (teto 15 min)', async () => {
    await ingestMessageEvents(rpcDb, [ev('wamid.A')], 'pending')
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      await db.exec(`UPDATE wacrm.webhook_message_inbox SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE state = 'pending'`)
      await drainMessageInbox(rpcDb, { process: async () => { throw new Error('x') } })
      const r = await db.query<{ s: number }>(`SELECT round(extract(epoch FROM next_attempt_at - clock_timestamp()))::int AS s FROM wacrm.webhook_message_inbox`)
      delays.push(r.rows[0].s)
    }
    expect(delays[0]).toBeGreaterThanOrEqual(28)
    expect(delays[0]).toBeLessThanOrEqual(30)
    expect(delays[1]).toBeGreaterThanOrEqual(58)
    expect(delays[5]).toBeLessThanOrEqual(900)
    expect(delays[5]).toBeGreaterThan(delays[2])
  })

  it('modo on é idempotente: mensagem já gravada em messages vira duplicate, sem reprocessar', async () => {
    await ingestMessageEvents(rpcDb, [ev('wamid.A')], 'pending')
    await db.exec(`INSERT INTO wacrm.messages(message_id) VALUES ('wamid.A')`) // o caminho antigo/outro processo já gravou
    // processador de verdade simplificado: insert com UNIQUE no wamid → 23505 → "duplicate"
    const summary = await drainMessageInbox(rpcDb, {
      process: async (r) => {
        const exists = await db.query('SELECT 1 FROM wacrm.messages WHERE message_id = $1', [r.message_id])
        return exists.rows.length > 0 ? 'duplicate' : 'processed'
      },
    })
    expect(summary).toMatchObject({ duplicates: 1, processed: 0 })
    expect((await rows())[0]).toMatchObject({ state: 'done', outcome: 'duplicate' })
  })

  it('ids próprios: o after() reserva só as mensagens do seu POST, sem esperar a vez', async () => {
    const own = await ingestMessageEvents(rpcDb, [ev('wamid.own')], 'pending')
    await ingestMessageEvents(rpcDb, [ev('wamid.other', '5511OUTRO')], 'pending')
    const seen: string[] = []
    await db.exec(`INSERT INTO wacrm.cron_locks VALUES ('webhook_message_drain','drain',now(), now() + interval '1 minute')`) // vez de outro
    const summary = await drainMessageInbox(rpcDb, {
      ids: own.ok ? own.ids : [],
      requireTurn: true,
      process: async (r) => (seen.push(r.message_id), 'processed'),
    })
    expect(seen).toEqual(['wamid.own'])
    expect(summary.claimed).toBe(1)
  })

  it('shadow: só compara. Existe em messages → shadow_match; não existe → shadow_missing; reação → n/a; nada é reprocessado', async () => {
    await ingestMessageEvents(rpcDb, [ev('wamid.ok'), ev('wamid.lost', '5511L'), ev('wamid.react', '5511R', 1_760_000_000, 'reaction')], 'shadow')
    await db.exec(`INSERT INTO wacrm.messages(message_id) VALUES ('wamid.ok')`)
    // o claim do drenador NÃO enxerga linhas shadow
    let processed = 0
    await drainMessageInbox(rpcDb, { process: async () => (processed++, 'processed') })
    expect(processed).toBe(0)
    // ainda novas demais: nada é comparado
    expect(await reconcileShadowInbox(rpcDb, 3600)).toMatchObject({ matched: 0, missing: 0 })
    const result = await reconcileShadowInbox(rpcDb, 0)
    expect(result).toMatchObject({ matched: 1, na: 1, missing: 1 })
    const state = Object.fromEntries((await rows()).map((r) => [r.message_id, `${r.state}/${r.outcome}`]))
    expect(state).toEqual({
      'wamid.ok': 'done/shadow_match',
      'wamid.lost': 'shadow_missing/shadow_missing',
      'wamid.react': 'done/shadow_na',
    })
    const stats = await db.query<{ s: { shadow_missing: number; dead: number } }>('SELECT wacrm.message_inbox_stats() AS s')
    expect(stats.rows[0].s).toMatchObject({ shadow_missing: 1, dead: 0 })
  })

  it('retenção: done > 3 dias e dead > 14 dias são podadas quando ocioso', async () => {
    await ingestMessageEvents(rpcDb, [ev('wamid.old'), ev('wamid.new', '5511N')], 'pending')
    await drainMessageInbox(rpcDb, { process: noop })
    await db.exec(`UPDATE wacrm.webhook_message_inbox SET processed_at = now() - interval '4 days' WHERE message_id = 'wamid.old'`)
    await reconcileShadowInbox(rpcDb, 0) // sem shadow: fase ociosa poda
    expect((await rows()).map((r) => r.message_id)).toEqual(['wamid.new'])
  })

  it('o payload não carrega token e o extrator só usa canal verificado', async () => {
    const body = {
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PN1' },
                contacts: [{ profile: { name: 'Maria' }, wa_id: '5511A' }],
                messages: [{ id: 'wamid.1', from: '5511A', timestamp: '1760000000', type: 'text', text: { body: 'oi' } }],
              },
            },
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PN-OUTRO' },
                contacts: [{ profile: { name: 'X' }, wa_id: '5511B' }],
                messages: [{ id: 'wamid.2', from: '5511B', timestamp: '1760000000', type: 'text' }],
              },
            },
          ],
        },
      ],
    }
    const channels = new Map([['phone:PN1', { id: CH, account_id: ACC }]])
    const events = extractMessageEvents(body, channels, (_e, c) => (c.value?.metadata?.phone_number_id ? `phone:${c.value.metadata.phone_number_id}` : null))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ account_id: ACC, channel_id: CH, message_id: 'wamid.1', sender: '5511A', ts: 1_760_000_000 })
    expect(JSON.stringify(events[0])).not.toMatch(/token/i)
  })
})
