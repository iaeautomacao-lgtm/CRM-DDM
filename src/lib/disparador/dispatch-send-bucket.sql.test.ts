// Migration 368 (worker de envio, W2): balde GCRA durável por número + claim em lote com fencing e fichas. PGlite com as funções REAIS do claim
// (118/125/159/164/167/188) e as migrations 366/367/368. O tempo é simulado deslocando `next_slot_at` (determinístico, sem dormir).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const A = '00000000-0000-0000-0000-000000000001';
const camp = '00000000-0000-0000-0000-000000000011';
const ch = '00000000-0000-0000-0000-000000000021';
const ch2 = '00000000-0000-0000-0000-000000000022';
let db: PGlite;

const migration = (file: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
type Row = { item: { id: string; status: string } | null; outcome: string };
const rated = async (session: string, n: number, rate: number | null, owner: string | null = 'w1', campaigns = [camp]) =>
  (await db.query<Row>('SELECT item, outcome FROM wacrm.claim_dispatch_batch_rated($1::uuid, $2, $3::uuid[], 150, $4::numeric, $5)', [session, n, `{${campaigns.join(',')}}`, rate, owner])).rows;
const claimed = (rows: Row[]) => rows.filter((r) => r.outcome === 'claimed' && r.item);
const reserve = async (session: string, n: number, rate: number | null, burst = 1) =>
  Number((await db.query<{ v: number }>('SELECT wacrm.reserve_send_slots($1::uuid, $2, $3::numeric, $4::numeric) AS v', [session, n, rate, burst])).rows[0].v);
// "Passou t segundos": o instante teórico do balde anda para trás.
const elapse = (session: string, seconds: number) =>
  db.exec(`UPDATE wacrm.dispatch_send_bucket SET next_slot_at = next_slot_at - interval '${seconds} seconds' WHERE session_id = '${session}'`);
const seed = (n: number, session = ch) =>
  db.exec(`
    INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, status, scheduled_at, mensagem_final)
    SELECT gen_random_uuid(), '${camp}', '${A}', '${session}', 'agendado', now() - interval '1 minute', '55119' || lpad(g::text, 8, '0')
    FROM generate_series(1, ${n}) g;
  `);
const enviando = async (session = ch) =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM wacrm.disp_message_queue WHERE session_id = $1 AND status = 'enviando'`, [session])).rows[0].n);

describe('migration 368 — balde GCRA durável e claim com fencing', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY);
      CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role text DEFAULT 'viewer') RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION wacrm.has_perm(p_key text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
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
      CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text, message_id text UNIQUE);
      CREATE TABLE wacrm.contact_import_variables (id serial PRIMARY KEY, campaign_id uuid, draft_id uuid);
      CREATE TABLE wacrm.message_logs (queue_id uuid, campaign_id uuid, contact_id uuid, session_id uuid, direcao text, mensagem text, status text, waha_message_id text);
      CREATE TABLE wacrm.campaign_metrics (campaign_id uuid PRIMARY KEY, total_enviados int DEFAULT 0, total_entregues int DEFAULT 0, total_lidos int DEFAULT 0, total_erros int DEFAULT 0);
      CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;
      CREATE TABLE wacrm.meta_131026_calls (account_id uuid, telefone text, campaign_id uuid);
      CREATE FUNCTION wacrm.record_meta_131026_failure(p_account_id uuid, p_telefone text, p_campaign_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      INSERT INTO wacrm.accounts VALUES ('${A}');
      INSERT INTO wacrm.whatsapp_config VALUES ('${ch}'), ('${ch2}');
    `);
    for (const file of [
      '118_dispatch_safety.sql', '125_pending_dispatch_receipts.sql', '159_dispatch_auto_pause_receipts_cleanup.sql', '164_dispatch_throughput.sql',
      '167_dispatch_claim_o1_retry_receipts.sql', '188_dispatch_batch_claim_confirm.sql', '366_dispatch_engine_flags.sql', '367_dispatch_worker_leases.sql',
    ]) {
      await db.exec(migration(file));
    }
    await db.exec(migration('368_dispatch_send_bucket.sql'));
    await db.exec(migration('368_dispatch_send_bucket.sql')); // idempotente
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.dispatch_channel_limits, wacrm.dispatch_status_receipts, wacrm.message_logs, wacrm.dispatch_send_bucket,
        wacrm.dispatch_worker_leases, wacrm.dispatch_channel_ownership;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns(id, account_id, status, limite_por_hora) VALUES ('${camp}', '${A}', 'em_execucao', NULL);
      INSERT INTO wacrm.dispatch_channel_ownership (session_id, account_id, mode) VALUES ('${ch}', '${A}', 'worker'), ('${ch2}', '${A}', 'worker');
    `);
    await db.query(`SELECT wacrm.acquire_dispatch_leases('w1', ARRAY['${ch}', '${ch2}']::uuid[], 30)`);
  });

  describe('reserve_send_slots (GCRA)', () => {
    it('a 1ª chamada concede a rajada de 1 s (taxa × 1) e a seguinte, na hora, quase nada: o limite vale entre chamadas', async () => {
      expect(await reserve(ch, 200, 80)).toBe(80);
      expect(await reserve(ch, 200, 80)).toBeLessThanOrEqual(2);
    });
    it('ao passar o tempo concede a proporção certa: 0,25 s a 80/s = 20 fichas', async () => {
      await reserve(ch, 200, 80);
      await elapse(ch, 0.25);
      const g = await reserve(ch, 200, 80);
      expect(g).toBeGreaterThanOrEqual(19);
      expect(g).toBeLessThanOrEqual(22);
    });
    it('nunca passa de p_n e nunca acumula crédito além da rajada, mesmo depois de muito tempo parado', async () => {
      await reserve(ch, 10, 80);
      await elapse(ch, 3600);
      expect(await reserve(ch, 500, 80)).toBe(80);
      await elapse(ch, 3600);
      expect(await reserve(ch, 5, 80)).toBe(5);
    });
    it('sem taxa (NULL ou ≤ 0) não limita e não cria linha; p_n ≤ 0 = 0; a rajada é limitada a 0,1–5 s', async () => {
      expect(await reserve(ch2, 150, null)).toBe(150);
      expect(await reserve(ch2, 150, 0)).toBe(150);
      expect(await reserve(ch2, 0, 80)).toBe(0);
      expect((await db.query(`SELECT 1 FROM wacrm.dispatch_send_bucket WHERE session_id = '${ch2}'`)).rows).toHaveLength(0);
      expect(await reserve(ch2, 1000, 10, 99)).toBe(50); // 99 s vira 5 s ⇒ 5 × 10
    });
    it('cada número tem o SEU balde: um número esgotado não atrasa o outro (justiça)', async () => {
      expect(await reserve(ch, 200, 80)).toBe(80);
      expect(await reserve(ch, 200, 80)).toBeLessThanOrEqual(2);
      expect(await reserve(ch2, 200, 40)).toBe(40);
    });
  });

  describe('claim_dispatch_batch_rated', () => {
    it('reivindica só o que o balde concede, marca enviando e na chamada seguinte responde throttled (esperar, não "vazio")', async () => {
      await seed(300);
      const first = await rated(ch, 100, 80);
      expect(claimed(first)).toHaveLength(80);
      expect(await enviando()).toBe(80);
      const second = await rated(ch, 100, 80);
      expect(claimed(second).length).toBeLessThanOrEqual(2);
      if (claimed(second).length === 0) expect(second.map((r) => r.outcome)).toEqual(['throttled']);
    });
    it('passou o tempo: reivindica a próxima faixa; itens não se repetem entre chamadas', async () => {
      await seed(300);
      const a = claimed(await rated(ch, 100, 80)).map((r) => r.item!.id);
      await elapse(ch, 1);
      const b = claimed(await rated(ch, 100, 80)).map((r) => r.item!.id);
      expect(b.length).toBe(70); // 1 s de fichas (80), mas só há 70 vagas livres (150 − 80 em voo): o limite de vagas também vale
      expect(a.filter((id) => b.includes(id))).toEqual([]);
    });
    it('sem nada vencido: outcome empty e a ficha NÃO se perde (o balde volta ao que era)', async () => {
      const r = await rated(ch, 100, 80);
      expect(r.map((x) => x.outcome)).toEqual(['empty']);
      expect(await reserve(ch, 100, 80)).toBe(80); // ainda cheio
    });
    it('o teto de vagas do número vale e o excedente volta ao balde: max_in_flight 10 ⇒ 10 itens, 70 fichas devolvidas', async () => {
      await db.exec(`INSERT INTO wacrm.dispatch_channel_limits (session_id, max_in_flight) VALUES ('${ch}', 10)`);
      await seed(300);
      expect(claimed(await rated(ch, 100, 80))).toHaveLength(10);
      expect(await enviando()).toBe(10);
      // mesmo com 10 já em voo (sem vaga), o balde segue cheio: só o limite de vagas barra
      const next = await rated(ch, 100, 80);
      expect(claimed(next)).toHaveLength(0);
      expect(await reserve(ch, 100, 80)).toBeGreaterThanOrEqual(60);
    });
    it('FENCING: dono errado, lease expirado, número devolvido ao cron ou lease inexistente ⇒ not_owner e NADA é reivindicado', async () => {
      await seed(50);
      for (const owner of ['w2', 'zumbi']) {
        const r = await rated(ch, 50, 80, owner);
        expect(r.map((x) => x.outcome)).toEqual(['not_owner']);
      }
      await db.exec(`UPDATE wacrm.dispatch_worker_leases SET lease_until = clock_timestamp() - interval '1 second' WHERE session_id = '${ch}'`);
      expect((await rated(ch, 50, 80, 'w1')).map((x) => x.outcome)).toEqual(['not_owner']);
      await db.query(`SELECT wacrm.acquire_dispatch_leases('w1', ARRAY['${ch}']::uuid[], 30)`);
      expect(claimed(await rated(ch, 50, 80, 'w1')).length).toBeGreaterThan(0);
      await db.exec(`UPDATE wacrm.dispatch_channel_ownership SET mode = 'cron' WHERE session_id = '${ch}'`);
      expect((await rated(ch, 50, 80, 'w1')).map((x) => x.outcome)).toEqual(['not_owner']);
    });
    it('o fencing não consome ficha do balde (zumbi não esgota o número do dono)', async () => {
      await seed(100);
      await rated(ch, 100, 80, 'zumbi');
      expect(claimed(await rated(ch, 100, 80, 'w1'))).toHaveLength(80);
    });
    it('sem fencing (dono NULL) e sem taxa: comporta-se como o claim em lote de sempre (limitado só pelas vagas do número)', async () => {
      await seed(300);
      const r = await rated(ch, 500, null, null);
      expect(claimed(r)).toHaveLength(150); // vagas padrão do número (150); sem balde nada é segurado
    });
    it('os dois números reivindicam de forma independente (cada um com o seu limite)', async () => {
      await seed(200, ch);
      await seed(200, ch2);
      expect(claimed(await rated(ch, 100, 80))).toHaveLength(80);
      expect(claimed(await rated(ch2, 100, 40))).toHaveLength(40);
      expect(await enviando(ch)).toBe(80);
      expect(await enviando(ch2)).toBe(40);
    });
  });

  it('só a service_role executa; a tabela do balde não tem leitura para o navegador', async () => {
    const rows = (await db.query<{ routine_name: string; grantee: string }>(
      `SELECT routine_name, grantee FROM information_schema.routine_privileges
        WHERE routine_schema='wacrm' AND routine_name IN ('reserve_send_slots','claim_dispatch_batch_rated') AND grantee IN ('anon','authenticated','PUBLIC','service_role')`,
    )).rows;
    expect([...new Set(rows.map((r) => r.grantee))]).toEqual(['service_role']);
    const tbl = (await db.query<{ grantee: string }>(`SELECT grantee FROM information_schema.table_privileges WHERE table_schema='wacrm' AND table_name='dispatch_send_bucket' AND grantee IN ('anon','authenticated','PUBLIC')`)).rows;
    expect(tbl).toEqual([]);
  });

  it('registra a migration e o ROLLBACK do cabeçalho executa (e dá para reaplicar)', async () => {
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '368_dispatch_send_bucket'`)).rows).toHaveLength(1);
    const header = migration('368_dispatch_send_bucket.sql').split('\nBEGIN;\n')[0];
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
    expect((await db.query<{ t: string | null }>(`SELECT to_regclass('wacrm.dispatch_send_bucket') AS t`)).rows[0].t).toBeNull();
    expect((await db.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wacrm' AND p.proname IN ('reserve_send_slots','claim_dispatch_batch_rated')`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '368_dispatch_send_bucket'`)).rows).toHaveLength(0);
    await db.exec(migration('368_dispatch_send_bucket.sql'));
    expect((await db.query(`SELECT 1 FROM wacrm.dispatch_send_bucket`)).rows).toHaveLength(0); // tabela recriada, vazia
  });
});
