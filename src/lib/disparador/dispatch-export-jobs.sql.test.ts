// Migration 203: dispatch_export_jobs + claim_dispatch_export_job (PGlite com a 203 real). Reserva por job (SKIP LOCKED + lease),
// ordem de chegada, lease vencido volta à fila, pendente com backoff futuro não é reservado, concluído/falho nunca,
// idempotência da migration e tabela fechada (RLS sem policy, só service_role).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;
const ACC = 'a0000000-0000-0000-0000-000000000001';
const CAMP = 'c0000000-0000-0000-0000-000000000001';
type Job = { id: string; state: string; owner_id: string | null; attempts: number; started_at: string | null };

const claim = async (owner = 'o1', lease = 120) =>
  (await db.query<Job>('SELECT * FROM wacrm.claim_dispatch_export_job($1, $2)', [owner, lease])).rows;
async function add(over: { state?: string; createdAgo?: string; nextAttempt?: string; lease?: string | null; status_key?: string } = {}) {
  const res = await db.query<{ id: string }>(
    `INSERT INTO wacrm.dispatch_export_jobs(account_id, campaign_id, status_key, state, created_at, next_attempt_at, lease_until)
     VALUES ($1,$2,$3,$4, now() - $5::interval, now() + $6::interval, ${over.lease === undefined || over.lease === null ? 'NULL' : "now() + '" + over.lease + "'::interval"}) RETURNING id`,
    [ACC, CAMP, over.status_key ?? 'enviado', over.state ?? 'pending', over.createdAgo ?? '0 seconds', over.nextAttempt ?? '-1 second'],
  );
  return res.rows[0].id;
}

describe('migration 203 — jobs de exportação da fila', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY);
      INSERT INTO wacrm.campaigns VALUES ('${CAMP}');
    `);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/203_dispatch_export_jobs.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE wacrm.dispatch_export_jobs');
  });

  it('reserva o job mais antigo, marca running com dono e lease; o seguinte só sai depois', async () => {
    const first = await add({ createdAgo: '10 minutes' });
    const second = await add({ createdAgo: '1 minute' });
    const got = await claim('o1');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: first, state: 'running', owner_id: 'o1', attempts: 0 });
    expect(got[0].started_at).toBeTruthy();
    expect((await claim('o2'))[0].id).toBe(second); // o primeiro está com lease vivo
    expect(await claim('o3')).toEqual([]);
  });

  it('lease vencido (processo caiu): outro processo reserva e conta a tentativa', async () => {
    const id = await add({ state: 'running', lease: '-1 minute' });
    const got = await claim('o2');
    expect(got[0]).toMatchObject({ id, state: 'running', owner_id: 'o2', attempts: 1 });
  });

  it('lease vivo não é reservado; pendente com backoff no futuro espera; done/failed/expired/cancelled nunca', async () => {
    await add({ state: 'running', lease: '+1 minute' });
    await add({ state: 'pending', nextAttempt: '+10 minutes' });
    for (const state of ['done', 'failed', 'expired', 'cancelled']) await add({ state });
    expect(await claim()).toEqual([]);
  });

  it('só o formato csv e só os estados válidos entram (CHECK)', async () => {
    await expect(db.exec(`INSERT INTO wacrm.dispatch_export_jobs(account_id, campaign_id, status_key, format) VALUES ('${ACC}','${CAMP}','x','pdf')`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO wacrm.dispatch_export_jobs(account_id, campaign_id, status_key, state) VALUES ('${ACC}','${CAMP}','x','zumbi')`)).rejects.toThrow();
  });

  it('tabela fechada: RLS ligada sem policy; anon/authenticated sem acesso; só service_role', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid = 'wacrm.dispatch_export_jobs'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    expect((await db.query("SELECT 1 FROM pg_policies WHERE schemaname='wacrm' AND tablename='dispatch_export_jobs'")).rows).toHaveLength(0);
    const g = await db.query<{ r: string; t: boolean; f: boolean }>(`
      SELECT r, has_table_privilege(r, 'wacrm.dispatch_export_jobs', 'SELECT') AS t,
             has_function_privilege(r, 'wacrm.claim_dispatch_export_job(text,integer)', 'EXECUTE') AS f
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r)`);
    expect(Object.fromEntries(g.rows.map((x) => [x.r, [x.t, x.f]]))).toEqual({ anon: [false, false], authenticated: [false, false], service_role: [true, true] });
  });

  it('apagar a campanha apaga os jobs dela (CASCADE)', async () => {
    await add();
    await db.exec(`DELETE FROM wacrm.campaigns WHERE id = '${CAMP}'`);
    expect((await db.query('SELECT 1 FROM wacrm.dispatch_export_jobs')).rows).toHaveLength(0);
    await db.exec(`INSERT INTO wacrm.campaigns VALUES ('${CAMP}')`);
  });

  it('registra a si mesma em schema_migrations (regra da 202) e tolera banco sem a 202', async () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/203_dispatch_export_jobs.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
    const other = new PGlite();
    await other.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
    `);
    await other.exec(sql);
    await other.exec(sql);
    expect((await other.query('SELECT version FROM wacrm.schema_migrations')).rows).toEqual([{ version: '203_dispatch_export_jobs' }]);
    await other.close();
  });
});
