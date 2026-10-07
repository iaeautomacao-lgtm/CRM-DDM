// Migration 184 (P0-6): lock do cron curto (F4) e pausa/encerramento/retomada de campanha grande em lotes (F5).
// Usa o claim REAL da 167 para provar que, depois do status trocado, nada mais é reivindicado.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const account = '00000000-0000-0000-0000-000000000001';
const campaign = '00000000-0000-0000-0000-000000000011';
const other = '00000000-0000-0000-0000-000000000012';
const channel = '00000000-0000-0000-0000-000000000021';
let db: PGlite;

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');

const one = async <T = unknown>(sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0].v;
const countStatus = async (c: string, status: string) =>
  Number(await one<string>('SELECT count(*) AS v FROM wacrm.disp_message_queue WHERE campaign_id=$1 AND status=$2', [c, status]));
const campaignStatus = (c: string) => one<string>('SELECT status AS v FROM wacrm.campaigns WHERE id=$1', [c]);
const claimAny = async (c: string) => {
  const row = await db.query<{ id: string }>(
    "SELECT id FROM wacrm.disp_message_queue WHERE campaign_id=$1 AND status IN ('agendado','pausado','cancelado','pendente') LIMIT 1",
    [c]
  );
  if (!row.rows[0]) return false;
  return one<boolean>('SELECT wacrm.claim_dispatch_item_capped($1::uuid, 50) AS v', [row.rows[0].id]);
};
const drain = async (c: string | null = null, limit = 5000) => {
  let total = 0;
  let calls = 0;
  for (;;) {
    const moved = Number(await one<number>('SELECT wacrm.process_dispatch_campaign_moves($1::uuid, $2) AS v', [c, limit]));
    calls++;
    total += moved;
    if (moved === 0 || calls > 200) return { total, calls };
  }
};

describe('migration 184 — lock curto e pausa em lotes', () => {
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
      CREATE TABLE wacrm.campaign_metrics (
        campaign_id uuid PRIMARY KEY, total_enviados int DEFAULT 0, total_entregues int DEFAULT 0,
        total_lidos int DEFAULT 0, total_erros int DEFAULT 0
      );
      CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;
      CREATE TABLE wacrm.meta_131026_calls (account_id uuid, telefone text, campaign_id uuid);
      CREATE FUNCTION wacrm.record_meta_131026_failure(p_account_id uuid, p_telefone text, p_campaign_id uuid)
      RETURNS void LANGUAGE sql AS $$ INSERT INTO wacrm.meta_131026_calls VALUES (p_account_id, p_telefone, p_campaign_id); $$;
      INSERT INTO wacrm.whatsapp_config VALUES ('${channel}');
    `);
    for (const file of [
      '113_cron_locks.sql',
      '118_dispatch_safety.sql',
      '125_pending_dispatch_receipts.sql',
      '159_dispatch_auto_pause_receipts_cleanup.sql',
      '164_dispatch_throughput.sql',
      '167_dispatch_claim_o1_retry_receipts.sql',
    ]) {
      await db.exec(migration(file));
    }
    // renew de produção (123/133): sempre 600 s, 2 argumentos.
    await db.exec(`
      CREATE OR REPLACE FUNCTION wacrm.renew_cron_lock(p_name text, p_owner text) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
      DECLARE affected integer; BEGIN
        UPDATE wacrm.cron_locks SET expires_at = clock_timestamp() + interval '600 seconds'
        WHERE name = p_name AND owner_id = p_owner AND expires_at > clock_timestamp();
        GET DIAGNOSTICS affected = ROW_COUNT; RETURN affected = 1; END; $$;
      -- retomada antiga (163) que a 184 substitui
      CREATE OR REPLACE FUNCTION wacrm.resume_dispatch_campaign_keep_schedule(p_campaign_id uuid, p_account_id uuid)
      RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
    `);
    const sql = migration('184_dispatch_lock_pausa.sql');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.dispatch_campaign_moves, wacrm.cron_locks, wacrm.dispatch_channel_limits,
        wacrm.dispatch_status_receipts, wacrm.messages, wacrm.message_logs, wacrm.campaign_metrics;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns(id, account_id, status) VALUES
        ('${campaign}', '${account}', 'em_execucao'), ('${other}', '${account}', 'em_execucao');
    `);
  });

  const seed = (c: string, n: number, status = 'agendado', scheduled = "now() - interval '1 minute'") =>
    db.exec(`
      INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, status, scheduled_at)
      SELECT gen_random_uuid(), '${c}', '${account}', '${channel}', '${status}', ${scheduled} FROM generate_series(1, ${n});
    `);

  describe('F4 — lock do cron', () => {
    it('aquisição sem TTL explícito vale 90 s; sem renovação expira e outro dono assume', async () => {
      expect(await one<boolean>("SELECT wacrm.try_acquire_cron_lock('disparador_cron', 'A') AS v")).toBe(true);
      const ttl = Number(await one<string>("SELECT extract(epoch FROM expires_at - now()) AS v FROM wacrm.cron_locks WHERE name='disparador_cron'"));
      expect(ttl).toBeGreaterThan(85);
      expect(ttl).toBeLessThanOrEqual(90);
      // Outro dono não entra enquanto vale…
      expect(await one<boolean>("SELECT wacrm.try_acquire_cron_lock('disparador_cron', 'B', 90) AS v")).toBe(false);
      // …e entra depois que expira (processo morreu: ninguém renovou).
      await db.exec("UPDATE wacrm.cron_locks SET expires_at = now() - interval '1 second' WHERE name='disparador_cron'");
      expect(await one<boolean>("SELECT wacrm.try_acquire_cron_lock('disparador_cron', 'B', 90) AS v")).toBe(true);
    });

    it('renovação estende para ~90 s (não 600), só do dono e só de lock vivo', async () => {
      await db.exec("SELECT wacrm.try_acquire_cron_lock('disparador_cron', 'A', 90)");
      await db.exec("UPDATE wacrm.cron_locks SET expires_at = now() + interval '20 seconds' WHERE name='disparador_cron'");
      // chamada exatamente como o cron faz: 2 argumentos nomeados
      expect(await one<boolean>("SELECT wacrm.renew_cron_lock(p_name => 'disparador_cron', p_owner => 'A') AS v")).toBe(true);
      const ttl = Number(await one<string>("SELECT extract(epoch FROM expires_at - now()) AS v FROM wacrm.cron_locks WHERE name='disparador_cron'"));
      expect(ttl).toBeGreaterThan(85);
      expect(ttl).toBeLessThanOrEqual(90);
      expect(await one<boolean>("SELECT wacrm.renew_cron_lock('disparador_cron', 'B') AS v")).toBe(false);
      await db.exec("UPDATE wacrm.cron_locks SET expires_at = now() - interval '1 second'");
      expect(await one<boolean>("SELECT wacrm.renew_cron_lock('disparador_cron', 'A') AS v")).toBe(false);
    });

    it('a versão de 2 argumentos saiu (sem ambiguidade) e o TTL é limitado a 30 s–1 h', async () => {
      expect(await one<string | null>("SELECT to_regprocedure('wacrm.renew_cron_lock(text,text)')::text AS v")).toBeNull();
      await db.exec("SELECT wacrm.try_acquire_cron_lock('x', 'A', 90)");
      await db.exec("SELECT wacrm.renew_cron_lock('x', 'A', 1)");
      const min = Number(await one<string>("SELECT extract(epoch FROM expires_at - now()) AS v FROM wacrm.cron_locks WHERE name='x'"));
      expect(min).toBeGreaterThan(25);
      expect(min).toBeLessThanOrEqual(30);
    });
  });

  describe('F5 — pausa e retomada em lotes', () => {
    it('pausar campanha de 100 mil itens: só o status muda (rápido) e o claim real não pega mais nada', async () => {
      await seed(campaign, 100_000);
      expect(await claimAny(campaign)).toBe(true); // em execução: claim funciona
      const t0 = Date.now();
      expect(await one<boolean>("SELECT wacrm.stop_dispatch_campaign($1::uuid, $2::uuid, 'pause') AS v", [campaign, account])).toBe(true);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1500);
      expect(await campaignStatus(campaign)).toBe('pausada');
      // Nenhum item foi tocado na transação do stop…
      expect(await countStatus(campaign, 'pausado')).toBe(0);
      // …e mesmo assim NENHUM claim funciona (campanha não está em execução).
      for (let i = 0; i < 5; i++) expect(await claimAny(campaign)).toBe(false);
    });

    it('os lotes movem agendado → pausado sem estourar tempo; o job some quando não resta item; enviando fica intacto', async () => {
      await seed(campaign, 12_000);
      await seed(campaign, 3, 'enviando');
      await seed(other, 50); // outra campanha em execução não é afetada
      await db.exec(`SELECT wacrm.stop_dispatch_campaign('${campaign}', '${account}', 'pause')`);
      const { total, calls } = await drain(campaign, 5000);
      expect(total).toBe(12_000);
      expect(calls).toBe(4); // 5000 + 5000 + 2000 + 0
      expect(await countStatus(campaign, 'pausado')).toBe(12_000);
      expect(await countStatus(campaign, 'enviando')).toBe(3);
      expect(await countStatus(other, 'agendado')).toBe(50);
      expect(Number(await one<string>('SELECT count(*) AS v FROM wacrm.dispatch_campaign_moves'))).toBe(0);
    });

    it('encerrar: agendado/pendente/pausado viram cancelado, em lotes; enviando e enviado ficam', async () => {
      await seed(campaign, 3000);
      await seed(campaign, 500, 'pausado');
      await seed(campaign, 100, 'pendente');
      await seed(campaign, 7, 'enviado');
      await seed(campaign, 4, 'enviando');
      expect(await one<boolean>("SELECT wacrm.stop_dispatch_campaign($1::uuid, $2::uuid, 'stop') AS v", [campaign, account])).toBe(true);
      expect(await campaignStatus(campaign)).toBe('encerrada');
      expect(await claimAny(campaign)).toBe(false);
      await drain(campaign, 1000);
      expect(await countStatus(campaign, 'cancelado')).toBe(3600);
      expect(await countStatus(campaign, 'enviado')).toBe(7);
      expect(await countStatus(campaign, 'enviando')).toBe(4);
    });

    it('pausar só vale para campanha em execução; conta de outra empresa não age', async () => {
      expect(await one<boolean>("SELECT wacrm.stop_dispatch_campaign($1::uuid, $2::uuid, 'pause') AS v", [campaign, '00000000-0000-0000-0000-0000000000ff'])).toBe(false);
      await db.exec(`SELECT wacrm.stop_dispatch_campaign('${campaign}', '${account}', 'pause')`);
      expect(await one<boolean>("SELECT wacrm.stop_dispatch_campaign($1::uuid, $2::uuid, 'pause') AS v", [campaign, account])).toBe(false);
    });

    it('retomar: campanha volta a executar na hora; itens voltam em lotes (agendado, vencidos agora) e só então são claimáveis', async () => {
      await seed(campaign, 11_000);
      await db.exec(`SELECT wacrm.stop_dispatch_campaign('${campaign}', '${account}', 'pause')`);
      await drain(campaign);
      expect(await countStatus(campaign, 'pausado')).toBe(11_000);

      const count = await one<number>("SELECT wacrm.resume_dispatch_campaign($1::uuid, $2::uuid) AS v", [campaign, account]);
      expect(Number(count)).toBe(11_000);
      expect(await campaignStatus(campaign)).toBe('em_execucao');
      // Itens ainda 'pausado' NÃO são enviados (o claim só pega 'agendado').
      expect(await countStatus(campaign, 'pausado')).toBe(11_000);
      const pausadoId = await one<string>("SELECT id AS v FROM wacrm.disp_message_queue WHERE campaign_id=$1 AND status='pausado' LIMIT 1", [campaign]);
      expect(await one<boolean>('SELECT wacrm.claim_dispatch_item_capped($1::uuid, 50) AS v', [pausadoId])).toBe(false);

      // Um lote só: 5.000 voltam (rampa natural, sem rajada de 11 mil de uma vez).
      expect(Number(await one<number>('SELECT wacrm.process_dispatch_campaign_moves($1::uuid, 5000) AS v', [campaign]))).toBe(5000);
      expect(await countStatus(campaign, 'agendado')).toBe(5000);
      expect(await countStatus(campaign, 'pausado')).toBe(6000);
      await drain(campaign);
      expect(await countStatus(campaign, 'agendado')).toBe(11_000);
      expect(await claimAny(campaign)).toBe(true);
    });

    it('retomada que preserva o ritmo (campanha em lote): scheduled_at já redistribuído NÃO vira "agora"; sem horário ganha agora', async () => {
      await db.exec(`
        INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, status, scheduled_at) VALUES
          ('00000000-0000-0000-0000-00000000a001', '${campaign}', '${account}', '${channel}', 'pausado', now() + interval '2 hours'),
          ('00000000-0000-0000-0000-00000000a002', '${campaign}', '${account}', '${channel}', 'pausado', now() + interval '3 hours'),
          ('00000000-0000-0000-0000-00000000a003', '${campaign}', '${account}', '${channel}', 'pausado', NULL);
        UPDATE wacrm.campaigns SET status = 'pausada' WHERE id = '${campaign}';
      `);
      expect(Number(await one<number>('SELECT wacrm.resume_dispatch_campaign_keep_schedule($1::uuid, $2::uuid) AS v', [campaign, account]))).toBe(3);
      await drain(campaign);
      const rows = (await db.query<{ id: string; status: string; wait: string }>(
        `SELECT id, status, extract(epoch FROM scheduled_at - now()) AS wait FROM wacrm.disp_message_queue
         WHERE campaign_id = '${campaign}' ORDER BY id`
      )).rows;
      expect(rows.map((r) => r.status)).toEqual(['agendado', 'agendado', 'agendado']);
      expect(Number(rows[0].wait)).toBeGreaterThan(7000); // continua ~2 h à frente
      expect(Number(rows[1].wait)).toBeGreaterThan(10_000);
      expect(Math.abs(Number(rows[2].wait))).toBeLessThan(5); // sem horário → agora
      // O claim respeita o horário: item de daqui a 2 h não sai.
      expect(await one<boolean>("SELECT wacrm.claim_dispatch_item_capped('00000000-0000-0000-0000-00000000a001'::uuid, 50) AS v")).toBe(false);
    });

    it('retomar uma campanha que não está pausada devolve NULL (sem reabrir a fila)', async () => {
      expect(await one<number | null>('SELECT wacrm.resume_dispatch_campaign($1::uuid, $2::uuid) AS v', [campaign, account])).toBeNull();
      await db.exec(`SELECT wacrm.stop_dispatch_campaign('${campaign}', '${account}', 'stop')`);
      expect(await one<number | null>('SELECT wacrm.resume_dispatch_campaign_keep_schedule($1::uuid, $2::uuid) AS v', [campaign, account])).toBeNull();
    });

    it('pausa e retomada em seguida (sem drenar): o job novo substitui o antigo e nada fica preso', async () => {
      await seed(campaign, 2000);
      await db.exec(`SELECT wacrm.stop_dispatch_campaign('${campaign}', '${account}', 'pause')`);
      await db.exec(`SELECT wacrm.resume_dispatch_campaign('${campaign}', '${account}')`);
      expect(await one<string>('SELECT action AS v FROM wacrm.dispatch_campaign_moves WHERE campaign_id=$1', [campaign])).toBe('resume');
      await drain(campaign);
      expect(await countStatus(campaign, 'agendado')).toBe(2000); // nunca saiu de agendado
      expect(await countStatus(campaign, 'pausado')).toBe(0);
      expect(Number(await one<string>('SELECT count(*) AS v FROM wacrm.dispatch_campaign_moves'))).toBe(0);
    });

    it('retomada seguida de nova pausa: itens ainda pausados ficam pausados e os agendados são pausados', async () => {
      await seed(campaign, 1000, 'pausado');
      await seed(campaign, 500);
      await db.exec(`UPDATE wacrm.campaigns SET status='pausada' WHERE id='${campaign}'`);
      await db.exec(`SELECT wacrm.resume_dispatch_campaign('${campaign}', '${account}')`);
      await db.exec(`SELECT wacrm.stop_dispatch_campaign('${campaign}', '${account}', 'pause')`);
      await drain(campaign);
      expect(await countStatus(campaign, 'pausado')).toBe(1500);
      expect(await countStatus(campaign, 'agendado')).toBe(0);
    });

    it('job obsoleto (status da campanha não corresponde) é descartado sem mover itens', async () => {
      await seed(campaign, 100);
      await db.exec(`INSERT INTO wacrm.dispatch_campaign_moves(campaign_id, action) VALUES ('${campaign}', 'pause')`); // campanha em execução
      expect(Number(await one<number>('SELECT wacrm.process_dispatch_campaign_moves() AS v'))).toBe(0);
      expect(await countStatus(campaign, 'agendado')).toBe(100);
      expect(Number(await one<string>('SELECT count(*) AS v FROM wacrm.dispatch_campaign_moves'))).toBe(0);
    });

    it('a manutenção do cron (sem campanha informada) termina o que a rota não terminou', async () => {
      await seed(campaign, 6000);
      await seed(other, 1500);
      await db.exec(`SELECT wacrm.stop_dispatch_campaign('${campaign}', '${account}', 'pause')`);
      await db.exec(`SELECT wacrm.stop_dispatch_campaign('${other}', '${account}', 'stop')`);
      const { total } = await drain(null, 2000);
      expect(total).toBe(7500);
      expect(await countStatus(campaign, 'pausado')).toBe(6000);
      expect(await countStatus(other, 'cancelado')).toBe(1500);
    });

    it('permissões: só service_role executa as funções e a tabela de jobs não é do navegador', async () => {
      const r = await db.query<{ a: boolean; b: boolean; c: boolean }>(`
        SELECT has_function_privilege('authenticated', 'wacrm.process_dispatch_campaign_moves(uuid,integer,integer)', 'EXECUTE') AS a,
               has_function_privilege('service_role', 'wacrm.process_dispatch_campaign_moves(uuid,integer,integer)', 'EXECUTE') AS b,
               has_table_privilege('authenticated', 'wacrm.dispatch_campaign_moves', 'SELECT') AS c`);
      expect(r.rows[0]).toEqual({ a: false, b: true, c: false });
    });
  });
});
