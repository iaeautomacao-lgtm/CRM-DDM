import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

// Migration 294: média de resposta atômica (F21) e recibo órfão de 48 h (W8).
let db: PGlite;
const C = '00000000-0000-0000-0000-0000000000c1';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA wacrm;
    CREATE TABLE wacrm.campaign_metrics (campaign_id uuid PRIMARY KEY, total_respostas integer DEFAULT 0, tempo_medio_resposta integer);
    CREATE TABLE wacrm.campaign_metric_deltas (campaign_id uuid, field text, n integer);
    CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), waha_message_id text);
    CREATE TABLE wacrm.dispatch_status_receipts (
      message_id text NOT NULL, status text NOT NULL, error_text text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (message_id, status)
    );
  `);
  const sql = readFileSync(resolve('supabase/migrations/294_campaign_reply_time_atomic.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql); // idempotente
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE wacrm.campaign_metrics, wacrm.campaign_metric_deltas, wacrm.dispatch_status_receipts');
});

const avg = async () =>
  (await db.query<{ tempo_medio_resposta: number | null }>(`SELECT tempo_medio_resposta FROM wacrm.campaign_metrics WHERE campaign_id='${C}'`)).rows[0]
    ?.tempo_medio_resposta;

it('primeira resposta grava o próprio tempo', async () => {
  await db.exec(`INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES ('${C}'); INSERT INTO wacrm.campaign_metric_deltas VALUES ('${C}','total_respostas',1)`);
  await db.exec(`SELECT wacrm.record_campaign_reply_time('${C}', 120)`);
  expect(await avg()).toBe(120);
});

it('média ponderada usa consolidado + deltas pendentes', async () => {
  // 3 respostas já contadas (2 consolidadas + 1 delta, esta incluída), média anterior 100: (100*2 + 400)/3 = 200
  await db.exec(`INSERT INTO wacrm.campaign_metrics VALUES ('${C}', 2, 100); INSERT INTO wacrm.campaign_metric_deltas VALUES ('${C}','total_respostas',1)`);
  await db.exec(`SELECT wacrm.record_campaign_reply_time('${C}', 400)`);
  expect(await avg()).toBe(200);
});

it('tempo inválido (<= 0) e campanha sem métricas não alteram nada', async () => {
  await db.exec(`INSERT INTO wacrm.campaign_metrics VALUES ('${C}', 2, 100)`);
  await db.exec(`SELECT wacrm.record_campaign_reply_time('${C}', 0)`);
  await db.exec(`SELECT wacrm.record_campaign_reply_time('00000000-0000-0000-0000-0000000000c2', 50)`);
  expect(await avg()).toBe(100);
});

it('recibo órfão: apaga > 48 h, mantém mais novo e o que tem item na fila', async () => {
  await db.exec(`
    INSERT INTO wacrm.disp_message_queue(waha_message_id) VALUES ('wamid.fila');
    INSERT INTO wacrm.dispatch_status_receipts(message_id, status, created_at) VALUES
      ('wamid.velho','delivered', now() - interval '49 hours'),
      ('wamid.novo','delivered', now() - interval '47 hours'),
      ('wamid.fila','delivered', now() - interval '60 hours');
  `);
  const { rows } = await db.query<{ n: number }>('SELECT wacrm.cleanup_orphan_dispatch_receipts(100) AS n');
  expect(rows[0].n).toBe(1);
  const left = await db.query<{ message_id: string }>('SELECT message_id FROM wacrm.dispatch_status_receipts ORDER BY 1');
  expect(left.rows.map((r) => r.message_id)).toEqual(['wamid.fila', 'wamid.novo']);
});
