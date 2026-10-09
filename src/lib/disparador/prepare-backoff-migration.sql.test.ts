// Migration 196: colunas do backoff da preparação + dispatch_import_set_block atômico (PGlite com a 196 real). A 197 (dispatch_import_jobs) é aplicada DEPOIS da função, como pode acontecer em produção: a função não depende dela na criação.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: PGlite;
const migration = (file: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
const ACC = 'a0000000-0000-0000-0000-000000000001';

describe('migration 196', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, status text, agendamento timestamptz);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
    `);
    const sql = migration('196_prepare_backoff_import_blocks.sql');
    await db.exec(sql);
    await db.exec(sql); // idempotente
    // A 197 (tabela dos jobs) vem DEPOIS da função, como pode acontecer em produção.
    await db.exec(migration('197_dispatch_import_jobs.sql'));
  });
  afterAll(async () => {
    await db.close();
  });

  it('campanhas ganham prepare_attempts (padrão 0) e next_prepare_at (nulo)', async () => {
    await db.exec(`INSERT INTO wacrm.campaigns(account_id, status) VALUES ('${ACC}', 'agendado')`);
    const row = (await db.query<{ prepare_attempts: number; next_prepare_at: string | null }>('SELECT prepare_attempts, next_prepare_at FROM wacrm.campaigns')).rows[0];
    expect(row).toEqual({ prepare_attempts: 0, next_prepare_at: null });
  });

  it('registra a si mesma em schema_migrations', async () => {
    const rows = (await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations WHERE version LIKE '196%'")).rows;
    expect(rows).toEqual([{ version: '196_prepare_backoff_import_blocks' }]);
  });

  async function newJob(state = 'receiving') {
    return (await db.query<{ id: string }>(`INSERT INTO wacrm.dispatch_import_jobs(account_id, state) VALUES ('${ACC}', '${state}') RETURNING id`)).rows[0].id;
  }
  const setBlock = async (id: string, n: number, rows: number) =>
    (await db.query<{ r: { blocks: Record<string, number>; rows_total: number } | null }>('SELECT wacrm.dispatch_import_set_block($1, $2, $3) AS r', [id, n, rows])).rows[0].r;

  it('dispatch_import_set_block: grava o bloco e SOMA rows_total numa instrução; reenviar o mesmo bloco substitui', async () => {
    const id = await newJob();
    expect(await setBlock(id, 0, 1000)).toMatchObject({ blocks: { '0': 1000 }, rows_total: 1000 });
    expect(await setBlock(id, 2, 350)).toMatchObject({ blocks: { '0': 1000, '2': 350 }, rows_total: 1350 });
    expect(await setBlock(id, 1, 1000)).toMatchObject({ blocks: { '0': 1000, '1': 1000, '2': 350 }, rows_total: 2350 });
    expect(await setBlock(id, 0, 500)).toMatchObject({ rows_total: 1850 }); // substitui, não soma duas vezes
  });

  it('PUTs "simultâneos" não perdem contador: 20 blocos gravados em paralelo aparecem todos', async () => {
    const id = await newJob();
    await Promise.all(Array.from({ length: 20 }, (_, n) => setBlock(id, n, 100 + n)));
    const row = (await db.query<{ blocks: Record<string, number>; rows_total: number }>('SELECT blocks, rows_total FROM wacrm.dispatch_import_jobs WHERE id = $1', [id])).rows[0];
    expect(Object.keys(row.blocks)).toHaveLength(20);
    expect(row.rows_total).toBe(Array.from({ length: 20 }, (_, n) => 100 + n).reduce((a, b) => a + b, 0));
  });

  it('job que não está recebendo (ou não existe) devolve NULL e não muda nada', async () => {
    const pending = await newJob('pending');
    expect(await setBlock(pending, 0, 10)).toBeNull();
    expect(await setBlock('00000000-0000-0000-0000-00000000dead', 0, 10)).toBeNull();
    expect((await db.query<{ blocks: object }>('SELECT blocks FROM wacrm.dispatch_import_jobs WHERE id = $1', [pending])).rows[0].blocks).toEqual({});
  });

  it('a função é fechada: só service_role executa', async () => {
    const g = await db.query<{ r: string; f: boolean }>(`
      SELECT r, has_function_privilege(r, 'wacrm.dispatch_import_set_block(uuid,integer,integer)', 'EXECUTE') AS f
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r)`);
    expect(Object.fromEntries(g.rows.map((x) => [x.r, x.f]))).toEqual({ anon: false, authenticated: false, service_role: true });
  });
});
