import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { phoneKey } from './phone-key';

const account = '00000000-0000-0000-0000-000000000001';
const campaign = '00000000-0000-0000-0000-000000000011';
const otherCampaign = '00000000-0000-0000-0000-000000000012';
const channel = '00000000-0000-0000-0000-000000000021';
const contact = '00000000-0000-0000-0000-000000000041';
const id = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
let db: PGlite;

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8');

async function claim(item: string, fallback: number | null = 10) {
  const result = await db.query<{ ok: boolean }>(
    'SELECT wacrm.claim_dispatch_item_capped($1::uuid, $2::int) AS ok',
    [item, fallback]
  );
  return result.rows[0].ok;
}

async function count(sql: string) {
  return (await db.query<{ n: number }>(sql)).rows[0].n;
}

describe('migration 167/168 — claim O(1), retry indexado, recibos sem órfãos', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.campaigns (
        id uuid PRIMARY KEY, account_id uuid, status text, limite_por_hora int,
        batch_pause_seconds int, updated_at timestamptz
      );
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, phone text);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY, campaign_id uuid REFERENCES wacrm.campaigns, account_id uuid,
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
      LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES (p_campaign_id) ON CONFLICT DO NOTHING;
        EXECUTE format('UPDATE wacrm.campaign_metrics SET %I=%I+1 WHERE campaign_id=$1', p_field, p_field)
        USING p_campaign_id;
      END $$;
      CREATE TABLE wacrm.meta_131026_calls (account_id uuid, telefone text, campaign_id uuid);
      CREATE FUNCTION wacrm.record_meta_131026_failure(p_account_id uuid, p_telefone text, p_campaign_id uuid)
      RETURNS void LANGUAGE sql AS $$
        INSERT INTO wacrm.meta_131026_calls VALUES (p_account_id, p_telefone, p_campaign_id);
      $$;
      INSERT INTO wacrm.whatsapp_config VALUES ('${channel}');
    `);
    for (const file of ['118_dispatch_safety.sql', '125_pending_dispatch_receipts.sql', '159_dispatch_auto_pause_receipts_cleanup.sql', '164_dispatch_throughput.sql']) {
      await db.exec(migration(file).replace(/NOTIFY pgrst[^;]*;/g, ''));
    }
    const sql = migration('167_dispatch_claim_o1_retry_receipts.sql').replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
    // Idempotente.
    await db.exec(sql);
    // 168: uma instrução por vez (CONCURRENTLY não roda em lote/transação).
    const indexes = migration('168_dispatch_capacity_indexes.sql')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(indexes.length).toBe(7);
    for (let pass = 0; pass < 2; pass++) for (const statement of indexes) await db.query(statement);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    const values = Array.from(
      { length: 6 },
      (_, i) => `('${id(i + 1)}','${campaign}','${account}','${channel}','agendado',now() - interval '1 minute')`
    );
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.dispatch_channel_limits, wacrm.dispatch_status_receipts,
        wacrm.messages, wacrm.message_logs, wacrm.campaign_metrics, wacrm.blacklist, wacrm.contacts,
        wacrm.meta_131026_calls;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns(id, account_id, status, limite_por_hora) VALUES
        ('${campaign}', '${account}', 'em_execucao', NULL),
        ('${otherCampaign}', '${account}', 'em_execucao', NULL);
      INSERT INTO wacrm.disp_message_queue(id,campaign_id,account_id,session_id,status,scheduled_at) VALUES ${values.join(',')};
    `);
  });

  describe('claim', () => {
    it('sem limite_por_hora: histórico da última hora não limita (sem contagem), teto por número continua', async () => {
      // 500 envios na última hora: com limite 5 isso bloquearia; sem limite, ignora.
      await db.exec(`
        INSERT INTO wacrm.disp_message_queue(id,campaign_id,session_id,status,sent_at)
        SELECT gen_random_uuid(), '${campaign}', '${channel}', 'enviado', now() - interval '10 minutes'
        FROM generate_series(1, 500);
      `);
      const results = [];
      for (let n = 1; n <= 4; n++) results.push(await claim(id(n), 3));
      expect(results).toEqual([true, true, true, false]);
    });

    it('com limite_por_hora: FOR UPDATE + contagem como antes (enviando + enviados na última hora)', async () => {
      await db.exec(`
        UPDATE wacrm.campaigns SET limite_por_hora = 3 WHERE id = '${campaign}';
        INSERT INTO wacrm.disp_message_queue(id,campaign_id,session_id,status,sent_at)
        VALUES (gen_random_uuid(), '${campaign}', '${channel}', 'enviado', now() - interval '10 minutes'),
               (gen_random_uuid(), '${campaign}', '${channel}', 'enviado', now() - interval '2 hours');
      `);
      const results = [];
      for (let n = 1; n <= 3; n++) results.push(await claim(id(n)));
      // 1 enviado na última hora + 2 enviando = 3 → o 3º é recusado.
      expect(results).toEqual([true, true, false]);
    });

    it('mantém as travas: item já reivindicado, com recibo, futuro ou campanha fora de execução', async () => {
      expect(await claim(id(1))).toBe(true);
      expect(await claim(id(1))).toBe(false);
      await db.exec(`UPDATE wacrm.disp_message_queue SET waha_message_id='wamid.x' WHERE id='${id(2)}'`);
      expect(await claim(id(2))).toBe(false);
      await db.exec(`UPDATE wacrm.disp_message_queue SET scheduled_at=now() + interval '1 hour' WHERE id='${id(3)}'`);
      expect(await claim(id(3))).toBe(false);
      await db.exec(`UPDATE wacrm.campaigns SET status='pausada' WHERE id='${campaign}'`);
      expect(await claim(id(4))).toBe(false);
    });

    it('limite e teto do canal valem entre campanhas (com ou sem limite_por_hora)', async () => {
      await db.exec(`
        INSERT INTO wacrm.dispatch_channel_limits VALUES ('${channel}', 2, 3);
        UPDATE wacrm.disp_message_queue SET campaign_id='${otherCampaign}' WHERE id IN ('${id(2)}','${id(4)}');
        UPDATE wacrm.campaigns SET limite_por_hora = 100 WHERE id = '${otherCampaign}';
      `);
      expect(await claim(id(1))).toBe(true);
      expect(await claim(id(2))).toBe(true);
      // max_in_flight 2 do número.
      expect(await claim(id(3))).toBe(false);
      await db.exec(`UPDATE wacrm.disp_message_queue SET status='enviado', sent_at=now() WHERE id IN ('${id(1)}','${id(2)}')`);
      expect(await claim(id(3))).toBe(true);
      // hourly_limit 3 do número: 2 enviados + 1 enviando.
      expect(await claim(id(4))).toBe(false);
    });

    it('claim_dispatch_item = capped com padrão 4', async () => {
      const results = [];
      for (let n = 1; n <= 5; n++) {
        const r = await db.query<{ ok: boolean }>('SELECT wacrm.claim_dispatch_item($1::uuid) AS ok', [id(n)]);
        results.push(r.rows[0].ok);
      }
      expect(results).toEqual([true, true, true, true, false]);
      const allowed = await db.query<{ a: boolean; s: boolean }>(
        "SELECT has_function_privilege('authenticated','wacrm.claim_dispatch_item(uuid)','execute') AS a, has_function_privilege('service_role','wacrm.claim_dispatch_item(uuid)','execute') AS s"
      );
      expect(allowed.rows[0]).toEqual({ a: false, s: true });
    });
  });

  describe('phone_key', () => {
    it('é a mesma chave de phone-key.ts', async () => {
      const samples = [
        '+5511999998888', '5511999998888', '11999998888', '+11999998888', '(11) 99999-8888',
        '1199998888', '+551199998888', '1134567890', '11934567890', '+5521987654321',
        '551134567890', '123', '', '+1 (415) 555-0100', '5511', '559999999999999', 'abc',
      ];
      for (const raw of samples) {
        const result = await db.query<{ k: string }>('SELECT wacrm.phone_key($1) AS k', [raw]);
        expect(result.rows[0].k, raw).toBe(phoneKey(raw));
      }
      const nullKey = await db.query<{ k: string }>('SELECT wacrm.phone_key(NULL) AS k');
      expect(nullKey.rows[0].k).toBe('');
    });

    it('blacklisted_phone_keys devolve só as chaves bloqueadas (qualquer formato gravado)', async () => {
      await db.exec(`INSERT INTO wacrm.blacklist(account_id, telefone) VALUES (NULL, '11 9999-8888'), ('${account}', '+5521987654321')`);
      const keys = [phoneKey('+5511999998888'), phoneKey('21987654321'), phoneKey('+5531911112222')];
      const result = await db.query<{ key: string }>('SELECT key FROM wacrm.blacklisted_phone_keys($1::text[])', [keys]);
      expect(result.rows.map((r) => r.key).sort()).toEqual([phoneKey('11999998888'), phoneKey('21987654321')].sort());
    });
  });

  describe('retry_transient_queue_errors', () => {
    beforeEach(async () => {
      await db.exec(`
        INSERT INTO wacrm.contacts VALUES ('${contact}', '+5511999998888');
        UPDATE wacrm.disp_message_queue
        SET status='erro', erro='timeout', tentativas=1, created_at=now() - interval '1 hour';
        UPDATE wacrm.disp_message_queue SET contact_id='${contact}' WHERE id='${id(1)}';
        UPDATE wacrm.disp_message_queue SET mensagem_final='5521987654321' WHERE id='${id(2)}';
        UPDATE wacrm.disp_message_queue SET erro_permanente=true WHERE id='${id(3)}';
        UPDATE wacrm.disp_message_queue SET tentativas=5 WHERE id='${id(4)}';
        UPDATE wacrm.disp_message_queue SET erro='(#131026) Message undeliverable' WHERE id='${id(5)}';
        UPDATE wacrm.disp_message_queue SET erro_permanente=NULL, created_at=now() WHERE id='${id(6)}';
      `);
    });

    it('reabre só os retentáveis; regra igual à anterior', async () => {
      const result = await db.query<{ n: number }>('SELECT wacrm.retry_transient_queue_errors() AS n');
      expect(result.rows[0].n).toBe(2);
      const reopened = await db.query<{ id: string }>(
        "SELECT id FROM wacrm.disp_message_queue WHERE status='agendado' ORDER BY id"
      );
      expect(reopened.rows.map((r) => r.id)).toEqual([id(1), id(2)]);
    });

    it('blacklist pela chave normalizada: outro formato do mesmo número também segura o retry', async () => {
      await db.exec(`
        INSERT INTO wacrm.blacklist(account_id, telefone) VALUES (NULL, '(11) 9999-8888');
        INSERT INTO wacrm.blacklist(account_id, telefone) VALUES ('${account}', '21 98765-4321');
      `);
      const result = await db.query<{ n: number }>('SELECT wacrm.retry_transient_queue_errors() AS n');
      expect(result.rows[0].n).toBe(0);
    });

    it('blacklist de outra conta não segura', async () => {
      await db.exec(`INSERT INTO wacrm.blacklist(account_id, telefone) VALUES (gen_random_uuid(), '+5511999998888')`);
      const result = await db.query<{ n: number }>('SELECT wacrm.retry_transient_queue_errors() AS n');
      expect(result.rows[0].n).toBe(2);
    });

    it('predicados batem com os índices da 168 (parcial da fila e expressão da blacklist)', async () => {
      const plan = async (sql: string) => {
        await db.exec('SET enable_seqscan = off');
        try {
          return (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
        } finally {
          await db.exec('RESET enable_seqscan');
        }
      };
      expect(
        await plan("SELECT 1 FROM wacrm.disp_message_queue q WHERE q.status='erro' AND q.erro_permanente IS NOT TRUE AND q.tentativas < 5")
      ).toContain('idx_dmq_retryable');
      expect(await plan("SELECT 1 FROM wacrm.blacklist b WHERE wacrm.phone_key(b.telefone) = ANY(ARRAY['1199998888'])")).toContain(
        'idx_blacklist_phone_key'
      );
    });

    it('campanha fora de execução não volta', async () => {
      await db.exec(`UPDATE wacrm.campaigns SET status='pausada' WHERE id='${campaign}'`);
      const result = await db.query<{ n: number }>('SELECT wacrm.retry_transient_queue_errors() AS n');
      expect(result.rows[0].n).toBe(0);
    });
  });

  describe('recibos', () => {
    const confirm = (item: string, wamid: string) =>
      db.query('SELECT wacrm.confirm_dispatch_item_sent($1,$2,NULL,$3,$4,$5,1)', [item, campaign, channel, 'olá', wamid]);
    const status = (wamid: string, value: string, error: string | null = null) =>
      db.query<{ changed: boolean }>('SELECT wacrm.apply_dispatch_status($1,$2,$3) AS changed', [wamid, value, error]);
    const receipts = () => count('SELECT count(*)::int AS n FROM wacrm.dispatch_status_receipts');

    it('mensagem do Inbox/IA/fluxo não deixa recibo órfão', async () => {
      await db.exec(`INSERT INTO wacrm.messages(message_id, sender_type) VALUES ('wamid.inbox', 'agent')`);
      expect((await status('wamid.inbox', 'delivered')).rows[0].changed).toBe(false);
      expect((await status('wamid.inbox', 'read')).rows[0].changed).toBe(false);
      expect(await receipts()).toBe(0);
    });

    it('status antes da confirmação: guarda e a confirmação reaplica na mesma chamada', async () => {
      expect(await claim(id(1))).toBe(true);
      expect((await status('wamid.early', 'delivered')).rows[0].changed).toBe(false);
      expect((await status('wamid.early', 'read')).rows[0].changed).toBe(false);
      expect(await receipts()).toBe(2);
      await confirm(id(1), 'wamid.early');
      const row = await db.query<{ status: string }>(`SELECT status FROM wacrm.disp_message_queue WHERE id='${id(1)}'`);
      expect(row.rows[0].status).toBe('lido');
      expect(await receipts()).toBe(0);
      const metrics = await db.query('SELECT total_enviados, total_entregues, total_lidos FROM wacrm.campaign_metrics');
      expect(metrics.rows[0]).toEqual({ total_enviados: 1, total_entregues: 1, total_lidos: 1 });
      // Idempotente: repetir a confirmação não duplica log nem métrica.
      await confirm(id(1), 'wamid.early');
      expect(await count('SELECT count(*)::int AS n FROM wacrm.message_logs')).toBe(1);
    });

    it('item enviando com waha_message_id (confirmação local falhou) guarda o recibo', async () => {
      await db.exec(`UPDATE wacrm.disp_message_queue SET status='enviando', waha_message_id='wamid.pend' WHERE id='${id(1)}'`);
      expect((await status('wamid.pend', 'delivered')).rows[0].changed).toBe(false);
      expect(await receipts()).toBe(1);
    });

    it('transição aplicada na hora não grava recibo; duplicada/velha é descartada', async () => {
      expect(await claim(id(1))).toBe(true);
      await confirm(id(1), 'wamid.ok');
      expect((await status('wamid.ok', 'delivered')).rows[0].changed).toBe(true);
      expect(await receipts()).toBe(0);
      expect((await status('wamid.ok', 'delivered')).rows[0].changed).toBe(false);
      expect(await receipts()).toBe(0);
    });

    it('failed com 131026 continua registrando a campanha (regra da 166)', async () => {
      await db.exec(`INSERT INTO wacrm.contacts VALUES ('${contact}', '+5511999998888')`);
      await db.exec(`UPDATE wacrm.disp_message_queue SET contact_id='${contact}' WHERE id='${id(1)}'`);
      expect(await claim(id(1))).toBe(true);
      await db.query('SELECT wacrm.confirm_dispatch_item_sent($1,$2,$3,$4,$5,$6,1)', [
        id(1), campaign, contact, channel, 'olá', 'wamid.f',
      ]);
      expect((await status('wamid.f', 'failed', 'Meta: x (code 131026)')).rows[0].changed).toBe(true);
      expect(await count('SELECT count(*)::int AS n FROM wacrm.meta_131026_calls')).toBe(1);
      const row = await db.query<{ status: string; erro_permanente: boolean }>(
        `SELECT status, erro_permanente FROM wacrm.disp_message_queue WHERE id='${id(1)}'`
      );
      expect(row.rows[0]).toEqual({ status: 'erro', erro_permanente: true });
    });

    it('limpeza da 159 continua coerente: apaga só recibo velho sem item; o de item enviando fica', async () => {
      await db.exec(`UPDATE wacrm.disp_message_queue SET status='enviando', waha_message_id='wamid.pend' WHERE id='${id(1)}'`);
      await status('wamid.pend', 'delivered');
      await status('wamid.semitem', 'delivered');
      await status('wamid.recente', 'read');
      await db.exec(`UPDATE wacrm.dispatch_status_receipts SET created_at = now() - interval '8 days' WHERE message_id <> 'wamid.recente'`);
      const deleted = await db.query<{ n: number }>('SELECT wacrm.cleanup_orphan_dispatch_receipts(5000) AS n');
      expect(deleted.rows[0].n).toBe(1);
      const left = await db.query<{ message_id: string }>('SELECT message_id FROM wacrm.dispatch_status_receipts ORDER BY 1');
      expect(left.rows.map((r) => r.message_id)).toEqual(['wamid.pend', 'wamid.recente']);
    });

    it('confirmação recusa identidade errada e não marca nada', async () => {
      expect(await claim(id(1))).toBe(true);
      await expect(
        db.query('SELECT wacrm.confirm_dispatch_item_sent($1,$2,NULL,$3,$4,$5,1)', [id(1), otherCampaign, channel, 'x', 'wamid.z'])
      ).rejects.toThrow(/identity mismatch/);
      const row = await db.query<{ status: string }>(`SELECT status FROM wacrm.disp_message_queue WHERE id='${id(1)}'`);
      expect(row.rows[0].status).toBe('enviando');
    });
  });
});
