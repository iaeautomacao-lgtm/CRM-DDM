// Migration 293: as funções de agregação do Dashboard (PGlite com a migration real) dão o MESMO resultado que a leitura antiga sobre os
// MESMOS dados — com bem mais de 1000 linhas, onde a leitura antiga (limitada a 1000 pelo PostgREST) sai cortada.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  legacyLoadAiAnalytics,
  legacyLoadConversationsSeries,
  legacyLoadResponseTime,
  loadAiAnalytics,
  loadConversationsSeries,
  loadConversationsStatusDonut,
  loadResponseTime,
} from './queries'

const ACC = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'a0000000-0000-0000-0000-000000000002'
const ME = 'e0000000-0000-0000-0000-000000000001'
const USERS = [
  { id: 'e0000000-0000-0000-0000-000000000011', name: 'Ana', email: 'ana@x.com' },
  { id: 'e0000000-0000-0000-0000-000000000012', name: '', email: 'bruno@x.com' },
  { id: 'e0000000-0000-0000-0000-000000000013', name: 'Carla', email: null },
]
const N_MESSAGES = 3600 // > 1000: o ponto do teste
const N_DEALS = 1500

let db: PGlite
const messagesAll: Row[] = []
const conversationsAll: Row[] = []
const dealsAll: Row[] = []
let profilesAll: Row[] = []

type Row = Record<string, unknown>

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sql = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')

/** Cliente "antigo": devolve as linhas já carregadas SÓ da conta de quem chama (o que a RLS fazia); `cap` imita o corte de 1000 linhas do PostgREST. */
function memoryDb(cap = Infinity): SupabaseClient {
  const mine = (rows: Row[]) => rows.filter((r) => r.account_id === undefined || r.account_id === ACC)
  const tables: Record<string, Row[]> = { messages: mine(messagesAll), conversations: mine(conversationsAll), deals: mine(dealsAll), profiles: profilesAll }
  return {
    from: (table: string) => {
      let rows = [...(tables[table] ?? [])]
      const order: Array<[string, boolean]> = []
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.gte = (c: string, v: string) => ((rows = rows.filter((r) => String(r[c]) >= v)), b)
      b.in = (c: string, vals: unknown[]) => ((rows = rows.filter((r) => vals.includes(r[c]))), b)
      b.order = (c: string, o: { ascending: boolean }) => (order.push([c, o.ascending]), b)
      b.then = (resolve: (v: unknown) => void) => {
        for (const [c, asc] of [...order].reverse()) rows.sort((x, y) => (String(x[c]) < String(y[c]) ? -1 : String(x[c]) > String(y[c]) ? 1 : 0) * (asc ? 1 : -1))
        resolve({ data: rows.slice(0, cap), error: null })
      }
      return b
    },
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
  } as unknown as SupabaseClient
}

/** Cliente "novo": as funções rodam no PGlite com a migration 293 real. */
function rpcDb(): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const keys = Object.keys(args)
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
      const values = keys.map((k) => args[k])
      if (fn === 'dashboard_conversations_series') {
        const r = await db.query(`SELECT * FROM wacrm.${fn}(${placeholders})`, values)
        return { data: r.rows, error: null }
      }
      const r = await db.query<{ r: unknown }>(`SELECT wacrm.${fn}(${placeholders}) AS r`, values)
      return { data: r.rows[0].r, error: null }
    },
  } as unknown as SupabaseClient
}

describe('migration 293 — agregados do Dashboard', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA wacrm;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $f$ SELECT '${ME}'::uuid $f$;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid, full_name text, email text);
      CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT account_id FROM wacrm.profiles WHERE user_id = auth.uid() LIMIT 1 $f$;
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid NOT NULL, status text, sentiment text);
      CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL, account_id uuid NOT NULL, sender_type text, created_at timestamptz NOT NULL);
      CREATE TABLE wacrm.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, status text, value numeric, user_id uuid);
      INSERT INTO wacrm.profiles VALUES ('${ME}', '${ACC}', 'Eu', 'eu@x.com');
    `)
    for (const u of USERS) await db.query('INSERT INTO wacrm.profiles VALUES ($1, $2, $3, $4)', [u.id, ACC, u.name, u.email])

    const rand = rng(42)
    const statuses = ['open', 'pending', 'closed', 'open', 'pending']
    const sentiments = ['positive', 'neutral', 'negative', 'mixed', null, 'positive']
    for (let i = 0; i < 60; i++) {
      const id = `c0000000-0000-0000-0000-${String(i).padStart(12, '0')}`
      conversationsAll.push({ id, account_id: ACC, status: statuses[i % statuses.length], sentiment: sentiments[i % sentiments.length] })
    }
    // Outra conta (a função nunca pode somar isto)
    conversationsAll.push({ id: 'c0000000-0000-0000-0000-0000000000ff', account_id: OTHER, status: 'open', sentiment: 'positive' })
    for (const c of conversationsAll) await db.query('INSERT INTO wacrm.conversations VALUES ($1,$2,$3,$4)', [c.id, c.account_id, c.status, c.sentiment])

    const now = Date.now()
    const senders = ['customer', 'customer', 'agent', 'bot', 'customer', 'agent']
    for (let i = 0; i < N_MESSAGES; i++) {
      const conv = conversationsAll[Math.floor(rand() * 60)]
      const at = new Date(now - Math.floor(rand() * 15 * 86_400_000)) // até 15 dias atrás (14 entram no tempo de resposta)
      const row = { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, conversation_id: conv.id, account_id: ACC, sender_type: senders[Math.floor(rand() * senders.length)], created_at: at.toISOString() }
      messagesAll.push(row)
    }
    messagesAll.push({ id: '00000000-0000-4000-8000-0000000fffff', conversation_id: 'c0000000-0000-0000-0000-0000000000ff', account_id: OTHER, sender_type: 'customer', created_at: new Date(now - 3600_000).toISOString() })
    for (const m of messagesAll) await db.query('INSERT INTO wacrm.messages VALUES ($1,$2,$3,$4,$5)', [m.id, m.conversation_id, m.account_id, m.sender_type, m.created_at])

    const dealStatuses = ['won', 'lost', 'open', 'won', 'open', 'qualquer']
    for (let i = 0; i < N_DEALS; i++) {
      const row = { account_id: ACC, status: dealStatuses[i % dealStatuses.length], value: i % 7 === 0 ? null : 100 + (i % 13) * 25.5, user_id: i % 5 === 0 ? null : USERS[i % USERS.length].id }
      dealsAll.push(row)
      await db.query('INSERT INTO wacrm.deals(account_id, status, value, user_id) VALUES ($1,$2,$3,$4)', [row.account_id, row.status, row.value, row.user_id])
    }
    dealsAll.push({ account_id: OTHER, status: 'won', value: 999999, user_id: USERS[0].id })
    await db.query('INSERT INTO wacrm.deals(account_id, status, value, user_id) VALUES ($1,$2,$3,$4)', [OTHER, 'won', 999999, USERS[0].id])
    profilesAll = [{ user_id: ME, full_name: 'Eu', email: 'eu@x.com' }, ...USERS.map((u) => ({ user_id: u.id, full_name: u.name, email: u.email }))]

    const migration = sql('293_dashboard_aggregates.sql')
    await db.exec(migration)
    await db.exec(migration) // idempotente
  })
  afterAll(async () => {
    await db.close()
  })

  it('registra a si mesma em schema_migrations; funções INVOKER (a RLS de quem chama vale), fechadas para anon', async () => {
    expect((await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations WHERE version LIKE '293%'")).rows).toEqual([{ version: '293_dashboard_aggregates' }])
    const f = await db.query<{ proname: string; secdef: boolean; anon: boolean; auth: boolean }>(`
      SELECT p.proname, p.prosecdef AS secdef,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'wacrm' AND p.proname LIKE 'dashboard_%' ORDER BY 1`)
    expect(f.rows.map((r) => r.proname)).toEqual(['dashboard_ai_analytics', 'dashboard_conversations_series', 'dashboard_conversations_status', 'dashboard_response_time'])
    expect(f.rows.every((r) => r.secdef === false && r.anon === false && r.auth === true)).toBe(true)
  })

  it('massa de teste passa de 1000 linhas (senão o teste não prova nada)', () => {
    expect(messagesAll.length).toBeGreaterThan(1000)
    expect(dealsAll.length).toBeGreaterThan(1000)
  })

  it('série por dia: igual à leitura antiga sem corte; a leitura antiga CORTADA em 1000 linhas perde mensagens', async () => {
    const viaRpc = await loadConversationsSeries(rpcDb(), 14)
    const full = await legacyLoadConversationsSeries(memoryDb(), 14)
    expect(viaRpc).toEqual(full)
    const total = (s: typeof viaRpc) => s.reduce((a, p) => a + p.incoming + p.outgoing, 0)
    expect(total(viaRpc)).toBeGreaterThan(1000)
    const capped = await legacyLoadConversationsSeries(memoryDb(1000), 14)
    expect(total(capped)).toBeLessThanOrEqual(1000) // o bug: totais cortados
    expect(total(capped)).toBeLessThan(total(viaRpc))
  })

  it('situação das conversas (donut): só da conta, igual à contagem direta', async () => {
    const donut = await loadConversationsStatusDonut(rpcDb())
    const open = conversationsAll.filter((c) => c.account_id === ACC && c.status === 'open').length
    const pending = conversationsAll.filter((c) => c.account_id === ACC && c.status === 'pending').length
    expect(donut.slices.find((s) => s.status === 'open')?.count).toBe(open)
    expect(donut.slices.find((s) => s.status === 'pending')?.count).toBe(pending)
    expect(donut.totalCount).toBe(open + pending)
  })

  it('tempo de resposta: mesmos buckets, mesmas amostras e médias da leitura antiga (que sai cortada com 1000)', async () => {
    const viaRpc = await loadResponseTime(rpcDb())
    const full = await legacyLoadResponseTime(memoryDb())
    expect(viaRpc.buckets.map((b) => [b.dow, b.samples])).toEqual(full.buckets.map((b) => [b.dow, b.samples]))
    viaRpc.buckets.forEach((b, i) => {
      if (b.avgMinutes === null) expect(full.buckets[i].avgMinutes).toBeNull()
      else expect(b.avgMinutes).toBeCloseTo(full.buckets[i].avgMinutes as number, 6)
    })
    for (const k of ['thisWeekAvg', 'lastWeekAvg'] as const) {
      if (viaRpc[k] === null) expect(full[k]).toBeNull()
      else expect(viaRpc[k] as number).toBeCloseTo(full[k] as number, 6)
    }
    const samples = (s: typeof viaRpc) => s.buckets.reduce((a, b) => a + b.samples, 0)
    expect(samples(viaRpc)).toBeGreaterThan(200)
    const capped = await legacyLoadResponseTime(memoryDb(1000))
    expect(samples(capped)).toBeLessThan(samples(viaRpc))
  })

  it('análises: sentimento, razão bot×humano, conversão e ranking de operadores iguais à leitura antiga; sem somar outra conta', async () => {
    const viaRpc = await loadAiAnalytics(rpcDb())
    const sameUniverse = await legacyLoadAiAnalytics(memoryDb())
    expect(viaRpc.sentiment).toEqual(sameUniverse.sentiment)
    expect(viaRpc.messagesRatio).toEqual(sameUniverse.messagesRatio)
    expect(viaRpc.conversion).toEqual(sameUniverse.conversion)
    expect(viaRpc.financials?.ticketMedio).toBe(sameUniverse.financials?.ticketMedio)
    expect(Number(viaRpc.financials?.totalWonValue)).toBeCloseTo(Number(sameUniverse.financials?.totalWonValue), 4)
    expect(Number(viaRpc.financials?.totalOpenValue)).toBeCloseTo(Number(sameUniverse.financials?.totalOpenValue), 4)
    expect(viaRpc.financials?.operators.map((o) => [o.userId, o.userName, o.dealCount, Number(o.totalWon)])).toEqual(
      sameUniverse.financials?.operators.map((o) => [o.userId, o.userName, o.dealCount, Number(o.totalWon)]),
    )
    expect(viaRpc.conversion.total).toBeGreaterThan(1000) // > 1000 deals contados de verdade
    expect(viaRpc.messagesRatio.total).toBeGreaterThan(1000)
  })
})
