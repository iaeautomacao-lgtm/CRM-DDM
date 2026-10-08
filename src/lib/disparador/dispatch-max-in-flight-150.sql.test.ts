// Migration 186: teto de max_in_flight 50 → 150 (CHECK da tabela + faixa do padrão no claim).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const account = '00000000-0000-0000-0000-000000000001';
const campaign = '00000000-0000-0000-0000-000000000011';
const channel = '00000000-0000-0000-0000-000000000021';
const channel2 = '00000000-0000-0000-0000-000000000022';
let db: PGlite;

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');

describe('migration 186 — tetos 150', () => {
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
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, phone text);
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
      LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;
      CREATE TABLE wacrm.meta_131026_calls (account_id uuid, telefone text, campaign_id uuid);
      CREATE FUNCTION wacrm.record_meta_131026_failure(p_account_id uuid, p_telefone text, p_campaign_id uuid)
      RETURNS void LANGUAGE sql AS $$ INSERT INTO wacrm.meta_131026_calls VALUES (p_account_id, p_telefone, p_campaign_id); $$;
      INSERT INTO wacrm.whatsapp_config VALUES ('${channel}'), ('${channel2}');
      INSERT INTO wacrm.campaigns(id, account_id, status) VALUES ('${campaign}', '${account}', 'em_execucao');
    `);
    for (const file of ['118_dispatch_safety.sql', '125_pending_dispatch_receipts.sql', '159_dispatch_auto_pause_receipts_cleanup.sql', '164_dispatch_throughput.sql', '167_dispatch_claim_o1_retry_receipts.sql']) {
      await db.exec(migration(file));
    }
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  const insertLimit = (session: string, value: number) =>
    db.query('INSERT INTO wacrm.dispatch_channel_limits(session_id, max_in_flight) VALUES ($1, $2)', [session, value]);

  it('antes da 186 o teto é 50 (CHECK antigo)', async () => {
    await expect(insertLimit(channel, 51)).rejects.toThrow(/check/i);
    await insertLimit(channel, 50);
    await db.exec(`DELETE FROM wacrm.dispatch_channel_limits`);
  });

  it('depois da 186 (e reaplicada): 1..150 vale; 0 e 151 continuam recusados', async () => {
    const sql = migration('186_dispatch_max_in_flight_150.sql');
    await db.exec(sql);
    await db.exec(sql); // idempotente
    await insertLimit(channel, 150);
    await expect(insertLimit(channel2, 151)).rejects.toThrow(/check/i);
    await expect(insertLimit(channel2, 0)).rejects.toThrow(/check/i);
    const checks = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_constraint WHERE conrelid = 'wacrm.dispatch_channel_limits'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%max_in_flight%'"
    );
    expect(Number(checks.rows[0].n)).toBe(1); // um CHECK só (o antigo saiu)
    await db.exec(`DELETE FROM wacrm.dispatch_channel_limits`);
  });

  it('claim: o padrão do app vale até 150 (antes caía para 4); fora de 1..150 volta para 4', async () => {
    // 119 itens já em envio no número (sem linha em dispatch_channel_limits → usa o padrão passado pelo app)
    await db.exec(`
      INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, status, sent_at)
      SELECT gen_random_uuid(), '${campaign}', '${account}', '${channel2}', 'enviando', now() FROM generate_series(1, 119);
      INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, status, scheduled_at)
      VALUES ('00000000-0000-0000-0000-00000000b001', '${campaign}', '${account}', '${channel2}', 'agendado', now() - interval '1 minute'),
             ('00000000-0000-0000-0000-00000000b002', '${campaign}', '${account}', '${channel2}', 'agendado', now() - interval '1 minute'),
             ('00000000-0000-0000-0000-00000000b003', '${campaign}', '${account}', '${channel2}', 'agendado', now() - interval '1 minute');
    `);
    const claim = async (id: string, def: number | null) =>
      (await db.query<{ v: boolean }>('SELECT wacrm.claim_dispatch_item_capped($1::uuid, $2::int) AS v', [id, def])).rows[0].v;
    // padrão 120: 119 em voo → o 120º entra; o 121º é recusado
    expect(await claim('00000000-0000-0000-0000-00000000b001', 120)).toBe(true);
    expect(await claim('00000000-0000-0000-0000-00000000b002', 120)).toBe(false);
    // padrão acima de 150 (inválido) → cai para 4 (já há 120 em voo → recusa)
    expect(await claim('00000000-0000-0000-0000-00000000b003', 151)).toBe(false);
    // padrão 150 é aceito: 120 em voo < 150
    expect(await claim('00000000-0000-0000-0000-00000000b003', 150)).toBe(true);
  });

  it('só service_role executa o claim', async () => {
    const r = await db.query<{ a: boolean; b: boolean }>(
      `SELECT has_function_privilege('authenticated', 'wacrm.claim_dispatch_item_capped(uuid,integer)', 'EXECUTE') AS a,
              has_function_privilege('service_role', 'wacrm.claim_dispatch_item_capped(uuid,integer)', 'EXECUTE') AS b`
    );
    expect(r.rows[0]).toEqual({ a: false, b: true });
  });
});
