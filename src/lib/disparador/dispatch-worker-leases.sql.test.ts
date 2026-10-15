// Migration 367 (worker de envio, W1): ownership, leases, RPCs e a chave worker_enabled. PGlite com a 366 REAL (a 367 acrescenta coluna nela).
// Prova: máximo um dono vivo por número; troca só depois de expirar; generation sobe só na troca de dono; renovar o que não é seu falha;
// mode='cron' devolve o número ao cron na hora; fencing; release; RLS de leitura; só service_role executa; rollback do cabeçalho.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const S1 = '00000000-0000-0000-0000-0000000000e1';
const S2 = '00000000-0000-0000-0000-0000000000e2';
const S3 = '00000000-0000-0000-0000-0000000000e3';
const SB = '00000000-0000-0000-0000-0000000000eb';
const ADMIN_A = '00000000-0000-0000-0000-0000000000a1';
const AGENT_A = '00000000-0000-0000-0000-0000000000a2';

const read = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
let db: PGlite;

const call = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(`SELECT ${sql} AS r`, params)).rows[0].r;
const acquire = (owner: string, ids: string[], ttl = 30) => call<string[]>('wacrm.acquire_dispatch_leases($1, $2::uuid[], $3)', [owner, ids, ttl]);
const renew = (owner: string, ids: string[], ttl = 30, stats: unknown = null) => call<string[]>('wacrm.renew_dispatch_leases($1, $2::uuid[], $3, $4::jsonb)', [owner, ids, ttl, stats === null ? null : JSON.stringify(stats)]);
const live = async () => ((await call<string[]>('wacrm.live_worker_sessions()')) ?? []).sort();
const isOwner = (id: string, owner: string) => call<boolean>('wacrm.dispatch_lease_is_owner($1::uuid, $2)', [id, owner]);
const gen = async (id: string) => Number((await db.query<{ g: string }>(`SELECT generation AS g FROM wacrm.dispatch_worker_leases WHERE session_id = $1`, [id])).rows[0].g);
const expire = (id: string) => db.exec(`UPDATE wacrm.dispatch_worker_leases SET lease_until = clock_timestamp() - interval '1 second' WHERE session_id = '${id}'`);
async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`SELECT set_config('test.uid', $1, false)`, [user]);
  await db.exec('SET ROLE authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('migration 367 — leases do worker de envio', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id));
      CREATE TABLE wacrm.members (user_id uuid, account_id uuid, perms text[]);
      CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role text DEFAULT 'viewer') RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.members m WHERE m.user_id = auth.uid() AND m.account_id = p_account) $$;
      CREATE FUNCTION wacrm.has_perm(p_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.members m WHERE m.user_id = auth.uid() AND p_key = ANY (m.perms)) $$;
      INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
      INSERT INTO wacrm.whatsapp_config VALUES ('${S1}', '${A}'), ('${S2}', '${A}'), ('${S3}', '${A}'), ('${SB}', '${B}');
      INSERT INTO wacrm.members VALUES ('${ADMIN_A}', '${A}', ARRAY['campaigns.rate_limit']), ('${AGENT_A}', '${A}', ARRAY[]::text[]);
    `);
    await db.exec(read('366_dispatch_engine_flags.sql'));
    await db.exec(read('367_dispatch_worker_leases.sql'));
    await db.exec(read('367_dispatch_worker_leases.sql')); // idempotente
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`
      DELETE FROM wacrm.dispatch_worker_leases; DELETE FROM wacrm.dispatch_channel_ownership;
      INSERT INTO wacrm.dispatch_channel_ownership (session_id, account_id, mode, worker_group) VALUES
        ('${S1}', '${A}', 'worker', 'A'), ('${S2}', '${A}', 'worker', 'A'), ('${S3}', '${A}', 'cron', NULL), ('${SB}', '${B}', 'worker', 'B');
    `);
  });

  it('só adquire número em mode=worker (cron e sem ownership ficam de fora); devolve os que ficaram com o dono', async () => {
    expect((await acquire('w1', [S1, S2, S3])).sort()).toEqual([S1, S2].sort());
    expect(await live()).toEqual([S1, S2].sort());
    expect(await acquire('w1', ['00000000-0000-0000-0000-0000000000ff'])).toEqual([]);
  });

  it('máximo UM dono vivo: outro worker não pega número com lease vivo; reafirmar o próprio é permitido e não sobe a generation', async () => {
    await acquire('w1', [S1]);
    expect(await acquire('w2', [S1])).toEqual([]);
    expect(await isOwner(S1, 'w1')).toBe(true);
    expect(await isOwner(S1, 'w2')).toBe(false);
    expect(await acquire('w1', [S1])).toEqual([S1]);
    expect(await gen(S1)).toBe(1);
  });

  it('depois que o lease expira outro worker assume (generation sobe) e o dono antigo perde o fencing e não renova', async () => {
    await acquire('w1', [S1]);
    await expire(S1);
    expect(await isOwner(S1, 'w1')).toBe(false); // expirado = não é dono vivo
    expect(await renew('w1', [S1])).toEqual([]); // não renova o que expirou
    expect(await acquire('w2', [S1])).toEqual([S1]);
    expect(await gen(S1)).toBe(2);
    expect(await isOwner(S1, 'w2')).toBe(true);
    // o zumbi volta: não é dono, não renova e não toma de volta enquanto o novo dono está vivo
    expect(await renew('w1', [S1])).toEqual([]);
    expect(await acquire('w1', [S1])).toEqual([]);
    expect(await isOwner(S1, 'w1')).toBe(false);
  });

  it('renew devolve só o que ainda é do dono e grava as estatísticas do heartbeat', async () => {
    await acquire('w1', [S1, S2]);
    await acquire('w2', [SB]);
    expect((await renew('w1', [S1, S2, SB], 30, { sent_per_s: 78 })).sort()).toEqual([S1, S2].sort());
    const stats = (await db.query<{ stats: { sent_per_s: number } }>(`SELECT stats FROM wacrm.dispatch_worker_leases WHERE session_id = '${S1}'`)).rows[0].stats;
    expect(stats.sent_per_s).toBe(78);
  });

  it('mudar o número para mode=cron devolve ao cron NA HORA: sai dos vivos, o dono não renova nem é dono', async () => {
    await acquire('w1', [S1]);
    expect(await live()).toEqual([S1]);
    await db.exec(`UPDATE wacrm.dispatch_channel_ownership SET mode = 'cron' WHERE session_id = '${S1}'`);
    expect(await live()).toEqual([]);
    expect(await renew('w1', [S1])).toEqual([]);
    expect(await isOwner(S1, 'w1')).toBe(false);
    expect(await acquire('w1', [S1])).toEqual([]);
  });

  it('release (SIGTERM) expira os leases do dono, mantém a linha e libera para outro; só os do próprio dono', async () => {
    await acquire('w1', [S1, S2]);
    await acquire('w2', [SB]);
    expect(Number(await call('wacrm.release_dispatch_leases($1)', ['w1']))).toBe(2);
    expect(await live()).toEqual([SB]);
    expect(await gen(S1)).toBe(1);
    expect((await acquire('w3', [S1, S2])).sort()).toEqual([S1, S2].sort());
    expect(await gen(S1)).toBe(2);
    expect(Number(await call('wacrm.release_dispatch_leases($1)', ['ninguem']))).toBe(0);
  });

  it('ttl é limitado a 5–300 s e owner vazio é recusado', async () => {
    await acquire('w1', [S1], 99999);
    const max = Number((await db.query<{ s: string }>(`SELECT extract(epoch FROM (lease_until - clock_timestamp()))::int AS s FROM wacrm.dispatch_worker_leases WHERE session_id = '${S1}'`)).rows[0].s);
    expect(max).toBeLessThanOrEqual(300);
    expect(max).toBeGreaterThan(290);
    await expect(acquire('  ', [S1])).rejects.toThrow(/owner/);
  });

  it('a chave worker_enabled entrou em dispatch_engine_flags (NULL = segue o ambiente)', async () => {
    await db.exec(`INSERT INTO wacrm.dispatch_engine_flags (account_id) VALUES ('${A}') ON CONFLICT DO NOTHING`);
    expect((await db.query<{ w: boolean | null }>(`SELECT worker_enabled AS w FROM wacrm.dispatch_engine_flags WHERE account_id = '${A}'`)).rows[0].w).toBeNull();
  });

  it('RLS: o navegador lê só da própria conta e só com campaigns.rate_limit; não escreve; service_role escreve', async () => {
    await acquire('w1', [S1, SB]);
    const count = (user: string, table: string) => as(user, async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.${table}`)).rows[0].n);
    expect(await count(ADMIN_A, 'dispatch_channel_ownership')).toBe(3); // S1, S2, S3 da conta A
    expect(await count(ADMIN_A, 'dispatch_worker_leases')).toBe(1);
    expect(await count(AGENT_A, 'dispatch_channel_ownership')).toBe(0);
    for (const sql of [`UPDATE wacrm.dispatch_channel_ownership SET mode = 'cron'`, `DELETE FROM wacrm.dispatch_worker_leases`, `SELECT wacrm.live_worker_sessions()`]) {
      await expect(as(ADMIN_A, () => db.exec(sql))).rejects.toThrow(/permission denied/i);
    }
  });

  it('só a service_role executa as RPCs', async () => {
    const rows = (await db.query<{ routine_name: string; grantee: string }>(
      `SELECT routine_name, grantee FROM information_schema.routine_privileges
        WHERE routine_schema='wacrm' AND routine_name IN ('acquire_dispatch_leases','renew_dispatch_leases','release_dispatch_leases','live_worker_sessions','dispatch_lease_is_owner')
          AND grantee IN ('anon','authenticated','PUBLIC','service_role')`,
    )).rows;
    expect([...new Set(rows.map((r) => r.grantee))]).toEqual(['service_role']);
    expect(new Set(rows.map((r) => r.routine_name)).size).toBe(5);
  });

  it('apagar o canal leva ownership e lease; a migration fica registrada', async () => {
    const S4 = '00000000-0000-0000-0000-0000000000e4';
    await db.exec(`INSERT INTO wacrm.whatsapp_config VALUES ('${S4}', '${A}'); INSERT INTO wacrm.dispatch_channel_ownership (session_id, account_id, mode) VALUES ('${S4}', '${A}', 'worker')`);
    await acquire('w1', [S4]);
    await db.exec(`DELETE FROM wacrm.whatsapp_config WHERE id = '${S4}'`);
    expect((await db.query(`SELECT 1 FROM wacrm.dispatch_worker_leases WHERE session_id = '${S4}'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.dispatch_channel_ownership WHERE session_id = '${S4}'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '367_dispatch_worker_leases'`)).rows).toHaveLength(1);
  });

  it('o ROLLBACK do cabeçalho executa (funções, tabelas, coluna e registro somem) e dá para reaplicar', async () => {
    const header = read('367_dispatch_worker_leases.sql').split('\nBEGIN;\n')[0];
    const block = header
      .slice(header.indexOf('-- ROLLBACK'))
      .split('\n')
      .slice(1)
      .filter((l) => l.startsWith('--   '))
      .map((l) => l.replace(/^--   /, ''))
      .join('\n');
    expect(block).toMatch(/^BEGIN;/);
    expect(block.trim()).toMatch(/COMMIT;$/);
    await db.exec(block);
    expect((await db.query<{ a: string | null; b: string | null }>(`SELECT to_regclass('wacrm.dispatch_worker_leases') AS a, to_regclass('wacrm.dispatch_channel_ownership') AS b`)).rows[0]).toEqual({ a: null, b: null });
    expect((await db.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wacrm' AND p.proname IN ('acquire_dispatch_leases','renew_dispatch_leases','release_dispatch_leases','live_worker_sessions','dispatch_lease_is_owner')`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='dispatch_engine_flags' AND column_name='worker_enabled'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '367_dispatch_worker_leases'`)).rows).toHaveLength(0);
    await db.exec(read('367_dispatch_worker_leases.sql'));
    expect((await db.query<{ t: string | null }>(`SELECT to_regclass('wacrm.dispatch_worker_leases') AS t`)).rows[0].t).not.toBeNull();
  });
});
