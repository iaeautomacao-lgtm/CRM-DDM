// Migration 366 (chaves do motor do Disparador pela tela). PGlite: a tabela, o RLS de leitura (campaigns.rate_limit + membro da conta),
// escrita só pela service_role, idempotência da migration e o ROLLBACK do cabeçalho executável.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const ADMIN_A = '00000000-0000-0000-0000-0000000000a1';
const AGENT_A = '00000000-0000-0000-0000-0000000000a2';
const ADMIN_B = '00000000-0000-0000-0000-0000000000b1';

const read = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
let db: PGlite;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`SELECT set_config('test.uid', $1, false)`, [user]);
  await db.exec('SET ROLE authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('migration 366 — chaves do motor do Disparador', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.members (user_id uuid, account_id uuid, perms text[]);
      -- is_account_member e has_perm no formato do banco: conta do usuário e permissão do papel dele.
      CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role text DEFAULT 'viewer') RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.members m WHERE m.user_id = auth.uid() AND m.account_id = p_account) $$;
      CREATE FUNCTION wacrm.has_perm(p_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.members m WHERE m.user_id = auth.uid() AND p_key = ANY (m.perms)) $$;
      INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
      INSERT INTO wacrm.members VALUES
        ('${ADMIN_A}', '${A}', ARRAY['campaigns.rate_limit']), ('${AGENT_A}', '${A}', ARRAY[]::text[]), ('${ADMIN_B}', '${B}', ARRAY['campaigns.rate_limit']);
    `);
    await db.exec(read('366_dispatch_engine_flags.sql'));
    await db.exec(read('366_dispatch_engine_flags.sql')); // idempotente
    await db.exec(`INSERT INTO wacrm.dispatch_engine_flags (account_id, batch_claim, tick_chain) VALUES ('${A}', true, NULL), ('${B}', NULL, false)`);
  });
  afterAll(async () => {
    await db.close();
  });

  it('NULL = seguir o ambiente: as colunas aceitam true, false e NULL, sem default', async () => {
    const rows = (await db.query<{ account_id: string; batch_claim: boolean | null; tick_chain: boolean | null }>(`SELECT * FROM wacrm.dispatch_engine_flags ORDER BY account_id`)).rows;
    expect(rows.map((r) => [r.batch_claim, r.tick_chain])).toEqual([[true, null], [null, false]]);
    await db.exec(`INSERT INTO wacrm.accounts VALUES ('00000000-0000-0000-0000-0000000000cc')`);
    await db.exec(`INSERT INTO wacrm.dispatch_engine_flags (account_id) VALUES ('00000000-0000-0000-0000-0000000000cc')`);
    const fresh = (await db.query<{ batch_claim: boolean | null; tick_chain: boolean | null }>(`SELECT batch_claim, tick_chain FROM wacrm.dispatch_engine_flags WHERE account_id = '00000000-0000-0000-0000-0000000000cc'`)).rows[0];
    expect(fresh).toEqual({ batch_claim: null, tick_chain: null });
  });

  it('o navegador lê só a linha da própria conta e só com campaigns.rate_limit', async () => {
    const count = (user: string) => as(user, async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.dispatch_engine_flags`)).rows[0].n);
    expect(await count(ADMIN_A)).toBe(1);
    expect(await count(ADMIN_B)).toBe(1);
    expect(await count(AGENT_A)).toBe(0); // membro sem a permissão não vê
    const other = await as(ADMIN_A, async () => (await db.query(`SELECT 1 FROM wacrm.dispatch_engine_flags WHERE account_id = '${B}'`)).rows.length);
    expect(other).toBe(0);
  });

  it('o navegador NÃO escreve (insert/update/delete negados); a service_role escreve', async () => {
    for (const sql of [
      `INSERT INTO wacrm.dispatch_engine_flags (account_id, batch_claim) VALUES ('${A}', false) ON CONFLICT (account_id) DO UPDATE SET batch_claim = false`,
      `UPDATE wacrm.dispatch_engine_flags SET batch_claim = false`,
      `DELETE FROM wacrm.dispatch_engine_flags`,
    ]) {
      await expect(as(ADMIN_A, () => db.exec(sql))).rejects.toThrow(/permission denied/i);
    }
    await db.exec('SET ROLE service_role');
    await db.exec(`UPDATE wacrm.dispatch_engine_flags SET tick_chain = true WHERE account_id = '${A}'`);
    await db.exec('RESET ROLE');
    expect((await db.query<{ tick_chain: boolean }>(`SELECT tick_chain FROM wacrm.dispatch_engine_flags WHERE account_id = '${A}'`)).rows[0].tick_chain).toBe(true);
  });

  it('apagar a conta leva as chaves junto; a migration fica registrada', async () => {
    await db.exec(`INSERT INTO wacrm.accounts VALUES ('00000000-0000-0000-0000-0000000000dd')`);
    await db.exec(`INSERT INTO wacrm.dispatch_engine_flags (account_id, tick_chain) VALUES ('00000000-0000-0000-0000-0000000000dd', true)`);
    await db.exec(`DELETE FROM wacrm.accounts WHERE id = '00000000-0000-0000-0000-0000000000dd'`);
    expect((await db.query(`SELECT 1 FROM wacrm.dispatch_engine_flags WHERE account_id = '00000000-0000-0000-0000-0000000000dd'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '366_dispatch_engine_flags'`)).rows).toHaveLength(1);
  });

  it('o ROLLBACK do cabeçalho executa (tabela e registro somem) e dá para reaplicar', async () => {
    const header = read('366_dispatch_engine_flags.sql').split('\nBEGIN;\n')[0];
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
    expect((await db.query(`SELECT to_regclass('wacrm.dispatch_engine_flags') AS t`)).rows[0]).toEqual({ t: null });
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '366_dispatch_engine_flags'`)).rows).toHaveLength(0);
    await db.exec(read('366_dispatch_engine_flags.sql'));
    expect((await db.query<{ t: string | null }>(`SELECT to_regclass('wacrm.dispatch_engine_flags') AS t`)).rows[0].t).not.toBeNull();
  });
});
