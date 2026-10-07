// Migration 192 (P1-6a): número pausado não recebe claim — nem por item (claim_dispatch_item[_capped]) nem em lote
// (claim_dispatch_batch). Usa as funções REAIS (118/125/159/164/167/186/188) em PGlite e aplica a 192 por cima.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const account = '00000000-0000-0000-0000-000000000001';
const camp = '00000000-0000-0000-0000-000000000011';
const ch = '00000000-0000-0000-0000-000000000021';
const ch2 = '00000000-0000-0000-0000-000000000022';
let db: PGlite;

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
const count = async (sql: string) => Number((await db.query<{ v: string }>(sql)).rows[0].v);
const claimBatch = async (session: string, n: number) =>
  (await db.query<{ item: { id: string } }>('SELECT item FROM wacrm.claim_dispatch_batch($1::uuid, $2, $3::uuid[], 20)', [session, n, `{${camp}}`])).rows;
const claimItem = async (id: string) =>
  (await db.query<{ v: boolean }>('SELECT wacrm.claim_dispatch_item($1::uuid) AS v', [id])).rows[0].v;
const claimCapped = async (id: string, def: number | null) =>
  (await db.query<{ v: boolean }>('SELECT wacrm.claim_dispatch_item_capped($1::uuid, $2) AS v', [id, def])).rows[0].v;

describe('migration 192 — pausa por número', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.campaigns (
        id uuid PRIMARY KEY, account_id uuid, status text, limite_por_hora int,
        batch_pause_seconds int, updated_at timestamptz, next_batch_at timestamptz
      );
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, name text, phone text, company text);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid REFERENCES wacrm.campaigns, account_id uuid,
        session_id uuid, contact_id uuid, mensagem_final text,
        status text, scheduled_at timestamptz, updated_at timestamptz, sent_at timestamptz,
        created_at timestamptz DEFAULT now(), waha_message_id text, tentativas int DEFAULT 0,
        erro_permanente boolean DEFAULT false, erro text
      );
      CREATE TABLE wacrm.blacklist (id serial PRIMARY KEY, account_id uuid, telefone text);
      CREATE TABLE wacrm.messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text, message_id text UNIQUE
      );
      CREATE TABLE wacrm.contact_import_variables (id serial PRIMARY KEY, campaign_id uuid, draft_id uuid);
      CREATE TABLE wacrm.message_logs (
        queue_id uuid, campaign_id uuid, contact_id uuid, session_id uuid,
        direcao text, mensagem text, status text, waha_message_id text
      );
      CREATE TABLE wacrm.campaign_metrics (campaign_id uuid PRIMARY KEY, total_enviados int DEFAULT 0, total_entregues int DEFAULT 0, total_lidos int DEFAULT 0, total_erros int DEFAULT 0);
      CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES (p_campaign_id) ON CONFLICT DO NOTHING;
        EXECUTE format('UPDATE wacrm.campaign_metrics SET %I=%I+1 WHERE campaign_id=$1', p_field, p_field) USING p_campaign_id;
      END $$;
      CREATE TABLE wacrm.meta_131026_calls (account_id uuid, telefone text, campaign_id uuid);
      CREATE FUNCTION wacrm.record_meta_131026_failure(p_account_id uuid, p_telefone text, p_campaign_id uuid)
      RETURNS void LANGUAGE sql AS $$ INSERT INTO wacrm.meta_131026_calls VALUES (p_account_id, p_telefone, p_campaign_id); $$;
      INSERT INTO wacrm.whatsapp_config VALUES ('${ch}'), ('${ch2}');
    `);
    for (const file of [
      '118_dispatch_safety.sql',
      '125_pending_dispatch_receipts.sql',
      '159_dispatch_auto_pause_receipts_cleanup.sql',
      '164_dispatch_throughput.sql',
      '167_dispatch_claim_o1_retry_receipts.sql',
      '186_dispatch_max_in_flight_150.sql',
      '188_dispatch_batch_claim_confirm.sql',
    ]) {
      await db.exec(migration(file));
    }
    const sql = migration('192_dispatch_channel_paused.sql');
    await db.exec(sql);
    await db.exec(sql); // idempotente: a segunda não duplica a checagem
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.dispatch_channel_limits, wacrm.dispatch_status_receipts, wacrm.messages,
        wacrm.message_logs, wacrm.campaign_metrics, wacrm.contacts;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns(id, account_id, status, limite_por_hora) VALUES ('${camp}', '${account}', 'em_execucao', NULL);
    `);
  });

  const seed = (session: string, n: number) =>
    db.exec(`
      INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, status, scheduled_at, mensagem_final)
      SELECT gen_random_uuid(), '${camp}', '${account}', '${session}', 'agendado', now() - interval '1 minute', '55119' || lpad(g::text, 8, '0')
      FROM generate_series(1, ${n}) g;
    `);
  const firstId = async (session: string) =>
    (await db.query<{ id: string }>(`SELECT id FROM wacrm.disp_message_queue WHERE session_id='${session}' AND status='agendado' ORDER BY id LIMIT 1`)).rows[0].id;
  const pause = (session: string, paused: boolean) =>
    db.exec(`INSERT INTO wacrm.dispatch_channel_limits(session_id, max_in_flight, paused) VALUES ('${session}', 20, ${paused})
             ON CONFLICT (session_id) DO UPDATE SET paused = ${paused}`);

  it('a coluna nasce falsa e a checagem aparece UMA vez em cada função de claim', async () => {
    await db.exec(`INSERT INTO wacrm.dispatch_channel_limits(session_id) VALUES ('${ch}')`);
    expect(await count(`SELECT count(*) AS v FROM wacrm.dispatch_channel_limits WHERE paused`)).toBe(0);
    for (const sig of ['wacrm.claim_dispatch_item_capped(uuid,integer)', 'wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)']) {
      const def = (await db.query<{ d: string }>(`SELECT pg_get_functiondef('${sig}'::regprocedure) AS d`)).rows[0].d;
      expect(def.match(/AND paused/g)).toHaveLength(1);
    }
  });

  it('claim por item: pausado devolve false e o item continua agendado; retomar libera', async () => {
    await seed(ch, 3);
    await pause(ch, true);
    const id = await firstId(ch);
    expect(await claimItem(id)).toBe(false);
    expect(await claimCapped(id, 20)).toBe(false);
    expect(await count(`SELECT count(*) AS v FROM wacrm.disp_message_queue WHERE status='enviando'`)).toBe(0);
    await pause(ch, false);
    expect(await claimItem(id)).toBe(true);
    expect(await count(`SELECT count(*) AS v FROM wacrm.disp_message_queue WHERE status='enviando'`)).toBe(1);
  });

  it('claim em lote: pausado devolve vazio; só o número pausado é afetado', async () => {
    await seed(ch, 5);
    await seed(ch2, 5);
    await pause(ch, true);
    expect(await claimBatch(ch, 5)).toHaveLength(0);
    expect(await claimBatch(ch2, 5)).toHaveLength(5);
    expect(await count(`SELECT count(*) AS v FROM wacrm.disp_message_queue WHERE session_id='${ch}' AND status='agendado'`)).toBe(5);
    await pause(ch, false);
    expect(await claimBatch(ch, 5)).toHaveLength(5);
  });

  it('itens já em envio não são tocados pela pausa', async () => {
    await seed(ch, 2);
    const id = await firstId(ch);
    expect(await claimItem(id)).toBe(true);
    await pause(ch, true);
    expect(await count(`SELECT count(*) AS v FROM wacrm.disp_message_queue WHERE status='enviando'`)).toBe(1);
  });

  it('a 192 aborta sem alterar nada quando não acha o ponto de inserção', async () => {
    const other = new PGlite();
    await other.exec(`
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.dispatch_channel_limits (session_id uuid PRIMARY KEY, max_in_flight int, hourly_limit int);
      CREATE FUNCTION wacrm.claim_dispatch_item_capped(p_item_id uuid, p_default integer) RETURNS boolean
      LANGUAGE sql AS $$ SELECT true $$;
    `);
    await expect(other.exec(migration('192_dispatch_channel_paused.sql'))).rejects.toThrow(/ponto de inserção/);
    // A transação ficou abortada (o SQL Editor faz o mesmo ROLLBACK): a coluna não pode ter ficado.
    await other.exec('ROLLBACK');
    const cols = await other.query(`SELECT 1 FROM information_schema.columns WHERE table_name='dispatch_channel_limits' AND column_name='paused'`);
    expect(cols.rows).toHaveLength(0);
    await other.close();
  });
});
