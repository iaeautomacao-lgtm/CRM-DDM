import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Migration 354 (Acordito): tabelas do copiloto, RLS com has_perm, cota 'copilot', idempotência e ROLLBACK executável.
const A = '00000000-0000-0000-0000-0000000000a1'
const B = '00000000-0000-0000-0000-0000000000b1'
const U1 = '00000000-0000-0000-0000-0000000000c1'
const U2 = '00000000-0000-0000-0000-0000000000c2'
const CONV_A = '00000000-0000-0000-0000-0000000000d1'
const CONV_B = '00000000-0000-0000-0000-0000000000d2'

const M339 = readFileSync(resolve('supabase/migrations/339_ai_daily_quota.sql'), 'utf8')
const M354 = readFileSync(resolve('supabase/migrations/354_acordito_copilot.sql'), 'utf8')

/** Bloco ROLLBACK do cabeçalho, como SQL executável. */
function rollbackSql(): string {
  const lines = M354.split('\n')
  const start = lines.findIndex((l) => l.startsWith('-- ROLLBACK:'))
  const end = lines.findIndex((l, i) => i > start && l.startsWith('-- ====='))
  return lines
    .slice(start, end)
    .map((l, i) => (i === 0 ? l.replace('-- ROLLBACK:', '') : l.replace(/^--\s?/, '')))
    .join('\n')
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm; CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA wacrm, auth TO authenticated, service_role;
    CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
    CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wacrm.accounts(id));
    CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
    INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
    INSERT INTO wacrm.conversations VALUES ('${CONV_A}', '${A}'), ('${CONV_B}', '${B}');
    -- Sessão simulada: app.uid (usuário), app.acc (conta), app.perms (permissões separadas por vírgula).
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('app.uid', true), '')::uuid $f$;
    CREATE FUNCTION wacrm.is_account_member(p_account uuid) RETURNS boolean LANGUAGE sql STABLE
      AS $f$ SELECT p_account::text = current_setting('app.acc', true) $f$;
    CREATE FUNCTION wacrm.has_perm(p text) RETURNS boolean LANGUAGE sql STABLE
      AS $f$ SELECT position(',' || p || ',' IN ',' || coalesce(current_setting('app.perms', true), '') || ',') > 0 $f$;
    CREATE TABLE wacrm.mfa_calls (tbl text);
    CREATE FUNCTION wacrm.apply_mfa_policy(t regclass) RETURNS void LANGUAGE sql AS $f$ INSERT INTO wacrm.mfa_calls VALUES (t::text) $f$;
  `)
  await db.exec(M339)
  return db
}

const as = async (db: PGlite, uid: string, acc: string, perms: string) => {
  await db.exec(`RESET ROLE; SELECT set_config('app.uid', '${uid}', false), set_config('app.acc', '${acc}', false), set_config('app.perms', '${perms}', false); SET ROLE authenticated;`)
}

describe('354 — Acordito', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await freshDb()
    await db.exec(M354)
    await db.exec(M354) // idempotente
  }, 90_000)

  afterAll(async () => {
    await db?.close()
  })

  it('registra a migration e cobre as três tabelas com a política de 2FA (quando existe)', async () => {
    const v = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '354_acordito_copilot'`)
    expect(v.rows[0].n).toBe(1)
    const m = await db.query<{ tbl: string }>(`SELECT DISTINCT tbl FROM wacrm.mfa_calls WHERE tbl LIKE 'wacrm.copilot_%' ORDER BY tbl`)
    expect(m.rows.map((r) => r.tbl)).toEqual(['wacrm.copilot_config', 'wacrm.copilot_events', 'wacrm.copilot_suggestions'])
  })

  it('cota diária: o tipo copilot conta, nega no teto e não consome a chamada negada; tipo inválido segue negado', async () => {
    const q = async (kind: string, def: number) =>
      (await db.query<{ r: { allowed: boolean; used: number; limit: number } }>(`SELECT wacrm.consume_ai_quota('${A}', '${kind}', ${def}) AS r`)).rows[0].r
    expect(await q('copilot', 2)).toEqual({ allowed: true, used: 1, limit: 2 })
    expect(await q('copilot', 2)).toEqual({ allowed: true, used: 2, limit: 2 })
    expect(await q('copilot', 2)).toEqual({ allowed: false, used: 2, limit: 2 })
    expect((await q('stt', 3)).allowed).toBe(true) // os tipos antigos seguem valendo
    expect((await q('outro', 3)).allowed).toBe(false)
    await db.exec(`INSERT INTO wacrm.ai_daily_quota_config (account_id, kind, daily_limit) VALUES ('${B}', 'copilot', 0)`)
    const b = await db.query<{ r: { allowed: boolean } }>(`SELECT wacrm.consume_ai_quota('${B}', 'copilot', 100) AS r`)
    expect(b.rows[0].r.allowed).toBe(false) // linha da conta (0) vence o padrão
  })

  it('copilot_config: ler com inbox.view; gravar só com ai.config; conta isolada', async () => {
    await as(db, U1, A, 'inbox.view,inbox.reply')
    await expect(db.exec(`INSERT INTO wacrm.copilot_config (account_id, enabled) VALUES ('${A}', true)`)).rejects.toThrow()
    await as(db, U2, A, 'inbox.view,ai.config')
    await db.exec(`INSERT INTO wacrm.copilot_config (account_id, enabled, guidance) VALUES ('${A}', true, 'seja breve')`)
    await expect(db.exec(`INSERT INTO wacrm.copilot_config (account_id, enabled) VALUES ('${B}', true)`)).rejects.toThrow() // outra conta
    await as(db, U1, A, 'inbox.view')
    const r = await db.query<{ enabled: boolean; guidance: string }>(`SELECT enabled, guidance FROM wacrm.copilot_config`)
    expect(r.rows).toEqual([{ enabled: true, guidance: 'seja breve' }])
    await db.exec(`UPDATE wacrm.copilot_config SET enabled = false`) // sem ai.config: 0 linhas afetadas
    const still = await db.query<{ enabled: boolean }>(`SELECT enabled FROM wacrm.copilot_config`)
    expect(still.rows[0].enabled).toBe(true)
    await as(db, U1, A, 'reports.view_all') // sem inbox.view: não lê
    expect((await db.query(`SELECT * FROM wacrm.copilot_config`)).rows).toHaveLength(0)
    await db.exec('RESET ROLE')
  })

  it('copilot_config: orientação com mais de 4000 caracteres é recusada', async () => {
    await db.exec('RESET ROLE')
    await expect(db.exec(`INSERT INTO wacrm.copilot_config (account_id, guidance) VALUES ('${B}', '${'x'.repeat(4001)}')`)).rejects.toThrow()
  })

  it('copilot_suggestions: fechada para authenticated e anon', async () => {
    await as(db, U1, A, 'inbox.view,inbox.reply,ai.config,reports.view_all')
    await expect(db.exec(`SELECT * FROM wacrm.copilot_suggestions`)).rejects.toThrow()
    await db.exec('RESET ROLE; SET ROLE anon')
    await expect(db.exec(`SELECT * FROM wacrm.copilot_suggestions`)).rejects.toThrow()
    await db.exec('RESET ROLE')
    await db.exec(`INSERT INTO wacrm.copilot_suggestions (account_id, conversation_id, based_on_message_id, suggestions) VALUES ('${A}', '${CONV_A}', '${U1}', '[{"id":"s1","text":"oi"}]')`)
    const hit = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.copilot_suggestions WHERE account_id = '${A}' AND suggestions @> '[{"id":"s1"}]'`)
    expect(hit.rows[0].n).toBe(1)
  })

  it('copilot_events: inserir só o próprio usuário com inbox.reply; ler só com reports.view_all; ação inválida recusada', async () => {
    await as(db, U1, A, 'inbox.reply')
    await db.exec(`INSERT INTO wacrm.copilot_events (account_id, conversation_id, user_id, suggestion_id, action) VALUES ('${A}', '${CONV_A}', '${U1}', 's1', 'used')`)
    await expect(db.exec(`INSERT INTO wacrm.copilot_events (account_id, conversation_id, user_id, suggestion_id, action) VALUES ('${A}', '${CONV_A}', '${U2}', 's1', 'used')`)).rejects.toThrow() // em nome de outro
    await expect(db.exec(`INSERT INTO wacrm.copilot_events (account_id, conversation_id, user_id, suggestion_id, action) VALUES ('${A}', '${CONV_A}', '${U1}', 's1', 'enviado')`)).rejects.toThrow() // ação inválida
    await as(db, U1, A, 'inbox.view')
    await expect(db.exec(`INSERT INTO wacrm.copilot_events (account_id, conversation_id, user_id, suggestion_id, action) VALUES ('${A}', '${CONV_A}', '${U1}', 's2', 'edited')`)).rejects.toThrow() // sem inbox.reply
    expect((await db.query(`SELECT * FROM wacrm.copilot_events`)).rows).toHaveLength(0) // sem reports.view_all
    await as(db, U2, A, 'reports.view_all')
    expect((await db.query(`SELECT * FROM wacrm.copilot_events`)).rows).toHaveLength(1)
    await as(db, U2, B, 'reports.view_all')
    expect((await db.query(`SELECT * FROM wacrm.copilot_events`)).rows).toHaveLength(0) // outra conta
    await db.exec('RESET ROLE')
  })
})

describe('354 — ROLLBACK do cabeçalho', () => {
  it('executa, remove tudo, devolve a cota ao que a 339 conhecia e pode ser reaplicado', async () => {
    const db = await freshDb()
    try {
      await db.exec(M354)
      await db.exec(`SELECT wacrm.consume_ai_quota('${A}', 'copilot', 5)`)
      await db.exec(rollbackSql())
      for (const t of ['copilot_config', 'copilot_suggestions', 'copilot_events']) {
        const r = await db.query<{ x: string | null }>(`SELECT to_regclass('wacrm.${t}')::text AS x`)
        expect(r.rows[0].x, t).toBeNull()
      }
      const v = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '354_acordito_copilot'`)
      expect(v.rows[0].n).toBe(0)
      const denied = await db.query<{ r: { allowed: boolean } }>(`SELECT wacrm.consume_ai_quota('${A}', 'copilot', 5) AS r`)
      expect(denied.rows[0].r.allowed).toBe(false)
      const ok = await db.query<{ r: { allowed: boolean } }>(`SELECT wacrm.consume_ai_quota('${A}', 'stt', 5) AS r`)
      expect(ok.rows[0].r.allowed).toBe(true)
      await db.exec(M354) // reaplica depois do rollback
    } finally {
      await db.close()
    }
  }, 90_000)
})
