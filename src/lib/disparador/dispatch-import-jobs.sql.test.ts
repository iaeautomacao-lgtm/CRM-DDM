// Migration 197: dispatch_import_jobs + claim_dispatch_import_job (PGlite com a 197 real). Reserva por job (SKIP LOCKED + lease),
// ordem de chegada, lease vencido volta à fila, só estados processáveis, idempotência, tabela fechada e registro em schema_migrations.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;
const ACC = 'a0000000-0000-0000-0000-000000000001';
type Job = { id: string; state: string; owner_id: string | null; attempts: number; started_at: string | null; totals: Record<string, number>; blocks: Record<string, number> };

const sqlOf = () => readFileSync(resolve(process.cwd(), 'supabase/migrations/197_dispatch_import_jobs.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
const claim = async (owner = 'o1', lease = 120) =>
  (await db.query<Job>('SELECT * FROM wacrm.claim_dispatch_import_job($1, $2)', [owner, lease])).rows;
async function add(over: { state?: string; createdAgo?: string; nextAttempt?: string; lease?: string | null } = {}) {
  const res = await db.query<{ id: string }>(
    `INSERT INTO wacrm.dispatch_import_jobs(account_id, state, created_at, next_attempt_at, lease_until)
     VALUES ($1,$2, now() - $3::interval, now() + $4::interval, ${over.lease ? `now() + '${over.lease}'::interval` : 'NULL'}) RETURNING id`,
    [ACC, over.state ?? 'pending', over.createdAgo ?? '0 seconds', over.nextAttempt ?? '-1 second'],
  );
  return res.rows[0].id;
}

describe('migration 197 — jobs de importação de contatos', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
    `);
    await db.exec(sqlOf());
    await db.exec(sqlOf()); // idempotente
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE wacrm.dispatch_import_jobs');
  });

  it('defaults: recebendo, sem blocos, totais zerados', async () => {
    const id = await add({ state: 'receiving' });
    const row = (await db.query<Job & { next_block: number }>('SELECT * FROM wacrm.dispatch_import_jobs WHERE id=$1', [id])).rows[0];
    expect(row).toMatchObject({ state: 'receiving', next_block: 0, blocks: {}, totals: { importados: 0, duplicados: 0, invalidos: 0, blacklisted: 0, variaveis_falhas: 0 } });
  });

  it('reserva o job mais antigo, marca running com dono e lease; o seguinte só sai depois', async () => {
    const first = await add({ createdAgo: '10 minutes' });
    const second = await add({ createdAgo: '1 minute' });
    const got = await claim('o1');
    expect(got[0]).toMatchObject({ id: first, state: 'running', owner_id: 'o1', attempts: 0 });
    expect((await claim('o2'))[0].id).toBe(second);
    expect(await claim('o3')).toEqual([]);
  });

  it('lease vencido (processo caiu): outro processo reserva e conta a tentativa; lease vivo não', async () => {
    const dead = await add({ state: 'running', lease: '-1 minute' });
    await add({ state: 'running', lease: '+1 minute', createdAgo: '1 hour' });
    const got = await claim('o2');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: dead, owner_id: 'o2', attempts: 1 });
    expect(await claim('o3')).toEqual([]);
  });

  it('só pendente vencido é processável: recebendo, com backoff futuro, done, failed e cancelled não', async () => {
    await add({ state: 'receiving' });
    await add({ state: 'pending', nextAttempt: '+10 minutes' });
    for (const state of ['done', 'failed', 'cancelled']) await add({ state });
    expect(await claim()).toEqual([]);
  });

  it('CHECK de estado', async () => {
    await expect(db.exec(`INSERT INTO wacrm.dispatch_import_jobs(account_id, state) VALUES ('${ACC}','zumbi')`)).rejects.toThrow();
  });

  it('tabela fechada: RLS ligada sem policy; anon/authenticated sem acesso; só service_role', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid = 'wacrm.dispatch_import_jobs'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    expect((await db.query("SELECT 1 FROM pg_policies WHERE schemaname='wacrm' AND tablename='dispatch_import_jobs'")).rows).toHaveLength(0);
    const g = await db.query<{ r: string; t: boolean; f: boolean }>(`
      SELECT r, has_table_privilege(r, 'wacrm.dispatch_import_jobs', 'SELECT') AS t,
             has_function_privilege(r, 'wacrm.claim_dispatch_import_job(text,integer)', 'EXECUTE') AS f
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r)`);
    expect(Object.fromEntries(g.rows.map((x) => [x.r, [x.t, x.f]]))).toEqual({ anon: [false, false], authenticated: [false, false], service_role: [true, true] });
  });

  it('registra a si mesma em schema_migrations (regra da 202) e tolera banco sem a 202', async () => {
    expect((await db.query('SELECT version FROM wacrm.schema_migrations')).rows).toEqual([{ version: '197_dispatch_import_jobs' }]);
    const other = new PGlite();
    await other.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA wacrm; CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY);`);
    await other.exec(sqlOf());
    await other.close();
  });
});
