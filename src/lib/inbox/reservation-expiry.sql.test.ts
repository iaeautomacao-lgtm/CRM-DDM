// Migration 384 (reserva do @operador: conversations.requested_at). PGlite com a migration REAL 376 (RPC, triggers de assumir/fechar) e a 384.
// Prova: o início da reserva é mantido sozinho pelo banco para QUALQUER caminho (RPC, atribuição, fechamento, liberação direta), o cliente não
// consegue mexer no prazo, a aplicação preenche as reservas que já existem, e o rollback do cabeçalho funciona.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8')
const migration = (file: string) => read(file).replace(/NOTIFY pgrst[^;]*;/g, '')
const ROLLBACK_384 = (() => {
  const text = read('384_reserva_requested_at.sql')
  return text
    .slice(text.indexOf('-- ROLLBACK-INICIO'), text.indexOf('-- ROLLBACK-FIM'))
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/^--\s?/, ''))
    .join('\n')
    .replace(/NOTIFY pgrst[^;]*;/g, '')
})()

const A = '00000000-0000-0000-0000-00000000000a'
const u = (n: number) => `00000000-0000-0000-0000-0000000006${String(n).padStart(2, '0')}`
const AG1 = u(1)
const AG2 = u(2)
const T1 = '00000000-0000-0000-0000-0000000007aa'

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id),
    account_role wacrm.account_role_enum NOT NULL, deactivated_at timestamptz);
  CREATE TABLE wacrm.teams (id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id));
  CREATE TABLE wacrm.team_members (team_id uuid REFERENCES wacrm.teams(id), user_id uuid, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (team_id, user_id));
  CREATE TABLE wacrm.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id),
    status text NOT NULL DEFAULT 'open', assigned_agent_id uuid, team_id uuid REFERENCES wacrm.teams(id),
    last_message_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), note text
  );
  CREATE TABLE wacrm.flow_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, conversation_id uuid,
    status text NOT NULL DEFAULT 'active', end_reason text, ended_at timestamptz);
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  CREATE FUNCTION wacrm.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_role::text FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role wacrm.account_role_enum DEFAULT 'viewer') RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = p_account AND p.account_role <= p_role) $$;
  ALTER TABLE wacrm.conversations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (wacrm.is_account_member(account_id));
  CREATE POLICY conversations_update ON wacrm.conversations FOR UPDATE USING (wacrm.is_account_member(account_id));
  GRANT SELECT, UPDATE ON wacrm.conversations TO authenticated;
  GRANT SELECT, INSERT, UPDATE ON wacrm.conversations, wacrm.flow_runs TO service_role;
  GRANT SELECT, UPDATE ON wacrm.profiles TO authenticated, service_role;
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A');
  INSERT INTO auth.users (id) VALUES ('${AG1}'), ('${AG2}');
  INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ('${AG1}', '${A}', 'agent'), ('${AG2}', '${A}', 'agent');
  INSERT INTO wacrm.teams (id, account_id) VALUES ('${T1}', '${A}');
  INSERT INTO wacrm.team_members (team_id, user_id) VALUES ('${T1}', '${AG1}'), ('${T1}', '${AG2}');
`

async function makeDb(opts: { with384?: boolean } = {}) {
  const db = new PGlite()
  await db.exec(BOOTSTRAP)
  await db.exec(migration('376_agent_mention_queue.sql'))
  await db.exec(`UPDATE wacrm.profiles SET mention_alias = 'ana' WHERE user_id = '${AG1}'; UPDATE wacrm.profiles SET mention_alias = 'bia' WHERE user_id = '${AG2}'`)
  if (opts.with384) await db.exec(migration('384_reserva_requested_at.sql'))
  return db
}

describe('migration 384 — conversations.requested_at', { timeout: 120_000 }, () => {
  let db: PGlite
  beforeAll(async () => {
    db = await makeDb({ with384: true })
  }, 60_000)
  afterAll(async () => {
    await db.close()
  }, 60_000)

  const conv = async (status = 'pending') =>
    (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, status, team_id) VALUES ($1, $2, $3) RETURNING id`, [A, status, T1])).rows[0].id
  const st = async (id: string) =>
    (await db.query<{ agent: string | null; at: string | null; fresh: boolean | null }>(
      `SELECT requested_agent_id AS agent, requested_at::text AS at, requested_at > now() - interval '1 minute' AS fresh FROM wacrm.conversations WHERE id = $1`, [id])).rows[0]
  const rpc = async (id: string, alias: string) => {
    await db.exec(`RESET ROLE; SET ROLE service_role`)
    const r = await db.query<{ v: string | null }>(`SELECT wacrm.route_conversation_to_mentioned_agent($1, $2, $3) AS v`, [A, id, alias])
    await db.exec(`RESET ROLE`)
    return r.rows[0].v
  }

  it('a RPC da 376 (sem editá-la) passa a registrar o início da reserva', async () => {
    const id = await conv()
    expect(await rpc(id, 'ana')).toBe(AG1)
    const s = await st(id)
    expect(s.agent).toBe(AG1)
    expect(s.fresh).toBe(true)
  })

  it('assumir (atribuir atendente) ou fechar limpa a reserva E o início, na mesma gravação', async () => {
    const a = await conv()
    await rpc(a, 'ana')
    await db.query(`UPDATE wacrm.conversations SET assigned_agent_id = $2 WHERE id = $1`, [a, AG1])
    expect(await st(a)).toEqual({ agent: null, at: null, fresh: null })
    const b = await conv()
    await rpc(b, 'ana')
    await db.query(`UPDATE wacrm.conversations SET status = 'closed' WHERE id = $1`, [b])
    expect(await st(b)).toEqual({ agent: null, at: null, fresh: null })
  })

  it('liberação direta (requested_agent_id = NULL, como a 382 e o cron) zera o início', async () => {
    const id = await conv()
    await rpc(id, 'ana')
    await db.query(`UPDATE wacrm.conversations SET requested_agent_id = NULL WHERE id = $1`, [id])
    expect(await st(id)).toEqual({ agent: null, at: null, fresh: null })
  })

  it('mesmo operador: o início NÃO anda (nem por escrita direta da coluna); outro operador: a reserva recomeça', async () => {
    const id = await conv()
    await rpc(id, 'ana')
    const before = (await st(id)).at
    await db.query(`UPDATE wacrm.conversations SET note = 'x', last_message_at = now(), updated_at = now() WHERE id = $1`, [id]) // mensagem nova do cliente
    await db.query(`UPDATE wacrm.conversations SET requested_at = '2020-01-01' WHERE id = $1`, [id]) // tentativa de adulterar
    await db.query(`UPDATE wacrm.conversations SET requested_agent_id = $2 WHERE id = $1`, [id, AG1]) // regravar o mesmo operador
    expect((await st(id)).at).toBe(before)
    await db.exec(`SELECT pg_sleep(0.05)`)
    await db.query(`UPDATE wacrm.conversations SET requested_agent_id = $2 WHERE id = $1`, [id, AG2])
    const after = await st(id)
    expect(after.agent).toBe(AG2)
    expect(after.at).not.toBe(before)
    expect(after.fresh).toBe(true)
  })

  it('o navegador não consegue mexer no prazo (escrever requested_at é ignorado)', async () => {
    const id = await conv()
    await rpc(id, 'ana')
    const before = (await st(id)).at
    await db.exec(`RESET ROLE; SELECT set_config('test.uid', '${AG1}', false); SET ROLE authenticated`)
    await db.query(`UPDATE wacrm.conversations SET requested_at = '2020-01-01' WHERE id = $1`, [id]).catch(() => null) // a 376 pode barrar; se passar, o trigger ignora
    await db.exec(`RESET ROLE`)
    expect((await st(id)).at).toBe(before)
    // conversa sem reserva: requested_at escrito à mão vira NULL
    const free = await conv()
    await db.query(`UPDATE wacrm.conversations SET requested_at = now() WHERE id = $1`, [free])
    expect(await st(free)).toEqual({ agent: null, at: null, fresh: null })
  })

  it('INSERT: com operador começa agora; só com a data (sem operador) vira NULL', async () => {
    const withAgent = (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, status, requested_agent_id, requested_at) VALUES ($1, 'pending', $2, '2020-01-01') RETURNING id`, [A, AG1])).rows[0].id
    expect((await st(withAgent)).fresh).toBe(true)
    const only = (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, status, requested_at) VALUES ($1, 'pending', now()) RETURNING id`, [A])).rows[0].id
    expect(await st(only)).toEqual({ agent: null, at: null, fresh: null })
  })

  it('atualizações comuns de conversa (status, equipe, mensagem) não mexem na reserva nem no início', async () => {
    const id = await conv()
    await rpc(id, 'ana')
    const before = await st(id)
    await db.query(`UPDATE wacrm.conversations SET status = 'open', updated_at = now() WHERE id = $1`, [id])
    expect(await st(id)).toEqual(before)
  })
})

describe('migration 384 — aplicação sobre reservas existentes, pré-check, idempotência e rollback', { timeout: 180_000 }, () => {
  it('reservas que já existem recebem requested_at = agora (o relógio de 30 min começa na aplicação)', async () => {
    const db = await makeDb()
    try {
      const id = (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, status, team_id) VALUES ($1, 'pending', $2) RETURNING id`, [A, T1])).rows[0].id
      await db.query(`UPDATE wacrm.conversations SET requested_agent_id = $2 WHERE id = $1`, [id, AG1])
      const free = (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id) VALUES ($1) RETURNING id`, [A])).rows[0].id
      await db.exec(migration('384_reserva_requested_at.sql'))
      const r = (await db.query<{ fresh: boolean }>(`SELECT requested_at > now() - interval '1 minute' AS fresh FROM wacrm.conversations WHERE id = $1`, [id])).rows[0]
      expect(r.fresh).toBe(true)
      expect((await db.query<{ at: string | null }>(`SELECT requested_at::text AS at FROM wacrm.conversations WHERE id = $1`, [free])).rows[0].at).toBeNull()
      expect((await db.query(`SELECT count(*) FROM wacrm.conversations WHERE requested_agent_id IS NOT NULL AND requested_at IS NULL`)).rows[0]).toEqual({ count: 0 })
    } finally {
      await db.close()
    }
  }, 60_000)

  it('pré-check: sem a coluna da 376 aborta sem criar nada; sem a RPC da 376 também', async () => {
    const d1 = await makeDb()
    try {
      await d1.exec(`DROP FUNCTION wacrm.route_conversation_to_mentioned_agent(uuid, uuid, text)`)
      await expect(d1.exec(migration('384_reserva_requested_at.sql'))).rejects.toThrow(/384: falta wacrm\.route_conversation_to_mentioned_agent/)
      await d1.exec('ROLLBACK') // o SQL Editor desfaz a transação ao dar erro; no PGlite a sessão fica abortada até o ROLLBACK
      expect((await d1.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'conversations' AND column_name = 'requested_at'`)).rows).toHaveLength(0)
    } finally {
      await d1.close()
    }
    const d2 = new PGlite()
    try {
      await d2.exec(BOOTSTRAP) // sem a 376: não existe requested_agent_id
      await expect(d2.exec(migration('384_reserva_requested_at.sql'))).rejects.toThrow(/384: faltam colunas/)
    } finally {
      await d2.close()
    }
  }, 60_000)

  it('idempotente, registra uma vez e tem lock_timeout na migration e no rollback', async () => {
    const db = await makeDb({ with384: true })
    try {
      await db.exec(migration('384_reserva_requested_at.sql'))
      expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '384_reserva_requested_at'`)).rows).toHaveLength(1)
      expect((await db.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_sync_mention_requested_at_%' AND NOT tgisinternal ORDER BY 1`)).rows.map((r) => (r as { tgname: string }).tgname))
        .toEqual(['trg_sync_mention_requested_at_ins', 'trg_sync_mention_requested_at_upd'])
    } finally {
      await db.close()
    }
    expect(migration('384_reserva_requested_at.sql')).toMatch(/BEGIN;\s*SET LOCAL lock_timeout = '5s';/)
    expect(ROLLBACK_384).toMatch(/SET LOCAL lock_timeout = '5s';/)
  }, 60_000)

  it('rollback (o bloco do cabeçalho): tira triggers, função e coluna e desregistra; a reserva em si continua funcionando; reaplicar funciona', async () => {
    const db = await makeDb({ with384: true })
    try {
      const id = (await db.query<{ id: string }>(`INSERT INTO wacrm.conversations (account_id, status, team_id) VALUES ($1, 'pending', $2) RETURNING id`, [A, T1])).rows[0].id
      await db.exec(ROLLBACK_384)
      expect((await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'conversations' AND column_name = 'requested_at'`)).rows).toHaveLength(0)
      expect((await db.query(`SELECT 1 FROM pg_trigger WHERE tgname LIKE 'trg_sync_mention_requested_at_%' AND NOT tgisinternal`)).rows).toHaveLength(0)
      expect((await db.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'sync_mention_requested_at'`)).rows).toHaveLength(0)
      expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '384_reserva_requested_at'`)).rows).toHaveLength(0)
      await db.exec(`RESET ROLE; SET ROLE service_role`)
      expect((await db.query<{ v: string }>(`SELECT wacrm.route_conversation_to_mentioned_agent($1, $2, 'ana') AS v`, [A, id])).rows[0].v).toBe(AG1) // a 376 segue intacta
      await db.exec(`RESET ROLE`)
      await db.exec(migration('384_reserva_requested_at.sql'))
      expect((await db.query<{ fresh: boolean }>(`SELECT requested_at > now() - interval '1 minute' AS fresh FROM wacrm.conversations WHERE id = $1`, [id])).rows[0].fresh).toBe(true) // backfill da reserva ativa
    } finally {
      await db.close()
    }
  }, 90_000)
})
