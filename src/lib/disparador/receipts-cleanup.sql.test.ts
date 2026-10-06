import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

// Migrations 158 (índice) e 159 (colunas de pausa automática + limpeza de
// recibos órfãos) num Postgres embutido.
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, status text);
    CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY, campaign_id uuid, status text, waha_message_id text);
    CREATE TABLE wacrm.dispatch_status_receipts (
      message_id text NOT NULL, status text NOT NULL, error_text text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (message_id, status)
    );
  `);
  await db.exec(readFileSync(resolve('supabase/migrations/158_dmq_waha_message_id_index.sql'), 'utf8'));
  const migration159 = readFileSync(resolve('supabase/migrations/159_dispatch_auto_pause_receipts_cleanup.sql'), 'utf8');
  await db.exec(migration159);
  await db.exec(migration159); // idempotente
}, 30_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE wacrm.dispatch_status_receipts, wacrm.disp_message_queue');
});

it('158 cria o índice parcial por waha_message_id', async () => {
  const { rows } = await db.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_dmq_waha_message_id'"
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].indexdef).toMatch(/WHERE \(waha_message_id IS NOT NULL\)/);
});

it('159 adiciona as colunas de pausa automática', async () => {
  const { rows } = await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='campaigns' ORDER BY column_name"
  );
  expect(rows.map((r) => r.column_name)).toEqual(
    expect.arrayContaining(['pausa_automatica_motivo', 'auto_pausa_avaliar_desde'])
  );
});

it('apaga só recibos antigos (> 7 dias) sem item correspondente na fila', async () => {
  await db.exec(`
    INSERT INTO wacrm.disp_message_queue VALUES (gen_random_uuid(), NULL, 'enviando', 'wamid.fila');
    INSERT INTO wacrm.dispatch_status_receipts(message_id, status, created_at) VALUES
      ('wamid.inbox.velho', 'read', now() - interval '8 days'),
      ('wamid.inbox.velho', 'delivered', now() - interval '8 days'),
      ('wamid.inbox.novo', 'read', now() - interval '1 day'),
      ('wamid.fila', 'delivered', now() - interval '30 days');
  `);
  const { rows } = await db.query<{ n: number }>('SELECT wacrm.cleanup_orphan_dispatch_receipts(5000) AS n');
  expect(rows[0].n).toBe(2);
  const left = await db.query<{ message_id: string }>(
    'SELECT message_id FROM wacrm.dispatch_status_receipts ORDER BY message_id'
  );
  expect(left.rows.map((r) => r.message_id)).toEqual(['wamid.fila', 'wamid.inbox.novo']);
});

it('respeita o limite por chamada (e nunca passa de 5000)', async () => {
  await db.exec(`
    INSERT INTO wacrm.dispatch_status_receipts(message_id, status, created_at)
    SELECT 'wamid.' || g, 'read', now() - interval '10 days' FROM generate_series(1, 30) g;
  `);
  const first = await db.query<{ n: number }>('SELECT wacrm.cleanup_orphan_dispatch_receipts(10) AS n');
  expect(first.rows[0].n).toBe(10);
  const rest = await db.query<{ n: number }>('SELECT wacrm.cleanup_orphan_dispatch_receipts(999999) AS n');
  expect(rest.rows[0].n).toBe(20);
});
