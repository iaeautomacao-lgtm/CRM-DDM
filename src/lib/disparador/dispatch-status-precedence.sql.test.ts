import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const account = '00000000-0000-0000-0000-000000000001';
const campaign = '00000000-0000-0000-0000-000000000011';
const channel = '00000000-0000-0000-0000-000000000021';
const contact = '00000000-0000-0000-0000-000000000041';
const phone = '+5511999998888';
const err131026 = 'Meta: Message undeliverable (code 131026)';
const id = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
const camp = (n: number) => `00000000-0000-0000-0000-0000000002${String(n).padStart(2, '0')}`;
let db: PGlite;

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');

const status = (wamid: string, value: string, error: string | null = null) =>
  db.query<{ changed: boolean }>('SELECT wacrm.apply_dispatch_status($1,$2,$3) AS changed', [wamid, value, error]);

async function item(n: number) {
  return (
    await db.query<{ status: string; erro: string | null; erro_permanente: boolean; entrega_pendente_131026: boolean }>(
      `SELECT status, erro, erro_permanente, entrega_pendente_131026 FROM wacrm.disp_message_queue WHERE id='${id(n)}'`
    )
  ).rows[0];
}
const metrics = async () =>
  (await db.query('SELECT total_enviados, total_entregues, total_lidos, total_erros FROM wacrm.campaign_metrics WHERE campaign_id=$1', [campaign]))
    .rows[0];
const failures = async () =>
  (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM wacrm.dispatch_meta_131026_failures')).rows[0].n;
const failuresBy = async (st: string) =>
  (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM wacrm.dispatch_meta_131026_failures WHERE status=$1', [st])).rows[0].n;
/** Confirma as pendentes (janela 0 = todas já vencidas), como o cron faz. */
const confirmPending = async (windowMinutes = 0) => {
  // Relógio grosso do PGlite: garante que a ocorrência já nasceu antes da checagem.
  await db.exec("UPDATE wacrm.dispatch_meta_131026_failures SET created_at = created_at - interval '1 second' WHERE status='pendente'");
  return (await db.query<{ n: number }>('SELECT wacrm.confirm_pending_meta_131026($1, 200) AS n', [windowMinutes])).rows[0].n;
};
const logs = async () =>
  (await db.query<{ event: string }>('SELECT event FROM wacrm.system_logs ORDER BY id')).rows.map((r) => r.event);
const blacklisted = async () =>
  (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM wacrm.blacklist')).rows[0].n;

/** Item 'enviado' com wamid, via confirmação normal (métrica de enviados). */
async function sentItem(n: number, wamid: string, campaignId = campaign) {
  await db.exec(`
    INSERT INTO wacrm.disp_message_queue(id,campaign_id,account_id,session_id,contact_id,status,scheduled_at)
    VALUES ('${id(n)}','${campaignId}','${account}','${channel}','${contact}','agendado',now() - interval '1 minute')
    ON CONFLICT (id) DO NOTHING;
  `);
  await db.query('SELECT wacrm.claim_dispatch_item_capped($1::uuid, 10)', [id(n)]);
  await db.query('SELECT wacrm.confirm_dispatch_item_sent($1,$2,$3,$4,$5,$6,1)', [
    id(n), campaignId, contact, channel, 'olá', wamid,
  ]);
}

describe('migration 172 — precedência de status (131026 seguido de delivered/read)', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
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
      CREATE TABLE wacrm.blacklist (
        id serial PRIMARY KEY, account_id uuid, telefone text UNIQUE, motivo text,
        campaign_id uuid, bloqueado_por text, data_bloqueio timestamptz
      );
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
        total_lidos int DEFAULT 0, total_erros int DEFAULT 0, total_blacklist int DEFAULT 0,
        updated_at timestamptz
      );
      CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES (p_campaign_id) ON CONFLICT DO NOTHING;
        EXECUTE format('UPDATE wacrm.campaign_metrics SET %I=%I+1 WHERE campaign_id=$1', p_field, p_field)
        USING p_campaign_id;
      END $$;
      CREATE TABLE wacrm.system_logs (
        id serial PRIMARY KEY, account_id uuid, level text, source text, event text, message text, payload jsonb
      );
      INSERT INTO wacrm.accounts VALUES ('${account}');
      INSERT INTO wacrm.whatsapp_config VALUES ('${channel}');
    `);
    for (const file of [
      '112_recalculate_campaign_metrics.sql',
      '118_dispatch_safety.sql',
      '125_pending_dispatch_receipts.sql',
      '159_dispatch_auto_pause_receipts_cleanup.sql',
      '164_dispatch_throughput.sql',
      '166_meta_131026_three_campaign_threshold.sql',
      '167_dispatch_claim_o1_retry_receipts.sql',
    ]) {
      await db.exec(migration(file));
    }
    const sql = migration('172_dispatch_status_precedence.sql');
    await db.exec(sql);
    // Idempotente.
    await db.exec(sql);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.dispatch_status_receipts, wacrm.messages,
        wacrm.message_logs, wacrm.campaign_metrics, wacrm.blacklist, wacrm.contacts,
        wacrm.dispatch_meta_131026_failures, wacrm.system_logs;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns(id, account_id, status) VALUES
        ('${campaign}', '${account}', 'em_execucao'),
        ('${camp(1)}', '${account}', 'em_execucao'),
        ('${camp(2)}', '${account}', 'em_execucao');
      INSERT INTO wacrm.contacts VALUES ('${contact}', '${phone}');
    `);
  });

  describe('failed depois de entregue/lido é ignorado', () => {
    for (const first of ['delivered', 'read'] as const) {
      it(`failed 131026 após ${first}: nada muda, sem erro e sem 131026`, async () => {
        await sentItem(1, 'wamid.a');
        expect((await status('wamid.a', first)).rows[0].changed).toBe(true);
        const before = await metrics();
        expect((await status('wamid.a', 'failed', err131026)).rows[0].changed).toBe(false);
        const row = await item(1);
        expect(row.status).toBe(first === 'read' ? 'lido' : 'entregue');
        expect(row.erro).toBeNull();
        expect(row.erro_permanente).toBe(false);
        expect(await metrics()).toEqual(before);
        expect(await failures()).toBe(0);
        expect(await blacklisted()).toBe(0);
      });
    }
  });

  describe('delivered/read depois de failed 131026', () => {
    it('read: item volta a lido, erro limpo, métricas ajustadas e ocorrência vira falso_positivo (mantida)', async () => {
      await sentItem(1, 'wamid.b');
      expect((await status('wamid.b', 'failed', err131026)).rows[0].changed).toBe(true);
      expect(await failures()).toBe(1);
      expect(await failuresBy('pendente')).toBe(1);
      // Provisório: o item segue 'enviado' (aguardando confirmação), sem total_erros.
      expect(await item(1)).toMatchObject({ status: 'enviado', erro_permanente: false, entrega_pendente_131026: true });
      expect((await item(1)).erro).toContain('Aguardando confirmação');
      expect(await metrics()).toMatchObject({ total_enviados: 1, total_erros: 0, total_entregues: 0, total_lidos: 0 });

      expect((await status('wamid.b', 'read')).rows[0].changed).toBe(true);
      expect(await item(1)).toEqual({ status: 'lido', erro: null, erro_permanente: false, entrega_pendente_131026: false });
      expect(await metrics()).toMatchObject({ total_enviados: 1, total_erros: 0, total_entregues: 1, total_lidos: 1 });
      expect(await failures()).toBe(1);
      expect(await failuresBy('falso_positivo')).toBe(1);
      expect(await logs()).toEqual(['meta_131026_false_positive']);
    });

    it('delivered: volta a entregue; read depois segue a precedência normal', async () => {
      await sentItem(1, 'wamid.c');
      await status('wamid.c', 'failed', err131026);
      expect((await status('wamid.c', 'delivered')).rows[0].changed).toBe(true);
      expect((await item(1)).status).toBe('entregue');
      expect(await metrics()).toMatchObject({ total_erros: 0, total_entregues: 1, total_lidos: 0 });
      expect((await status('wamid.c', 'read')).rows[0].changed).toBe(true);
      expect(await metrics()).toMatchObject({ total_erros: 0, total_entregues: 1, total_lidos: 1 });
    });

    it('erro que NÃO é 131026 continua permanente (delivered não reabre)', async () => {
      await sentItem(1, 'wamid.d');
      await status('wamid.d', 'failed', 'Meta: Re-engagement message (code 131047)');
      expect((await status('wamid.d', 'read')).rows[0].changed).toBe(false);
      expect(await item(1)).toMatchObject({ status: 'erro', erro_permanente: true });
      expect(await metrics()).toMatchObject({ total_erros: 1 });
    });

    it('recibos fora de ordem (failed e read antes da confirmação): terminam em lido', async () => {
      await db.exec(`
        INSERT INTO wacrm.disp_message_queue(id,campaign_id,account_id,session_id,contact_id,status,scheduled_at)
        VALUES ('${id(1)}','${campaign}','${account}','${channel}','${contact}','agendado',now() - interval '1 minute')
      `);
      await db.query('SELECT wacrm.claim_dispatch_item_capped($1::uuid, 10)', [id(1)]);
      await status('wamid.e', 'failed', err131026);
      await status('wamid.e', 'read');
      await db.query('SELECT wacrm.confirm_dispatch_item_sent($1,$2,$3,$4,$5,$6,1)', [
        id(1), campaign, contact, channel, 'olá', 'wamid.e',
      ]);
      // O replay pode aplicar failed→read ou read→failed; em ambos o resultado é lido.
      expect((await item(1)).status).toBe('lido');
      expect((await item(1)).erro).toBeNull();
      expect(await metrics()).toMatchObject({ total_erros: 0, total_lidos: 1 });
    });
  });

  describe('131026 provisório: pendente → confirmado | falso_positivo', () => {
    it('failed assíncrono grava pendente e NÃO bloqueia, mesmo em 3 campanhas', async () => {
      await sentItem(1, 'wamid.1', campaign);
      await sentItem(2, 'wamid.2', camp(1));
      await sentItem(3, 'wamid.3', camp(2));
      for (const w of ['wamid.1', 'wamid.2', 'wamid.3']) await status(w, 'failed', err131026);
      expect(await failuresBy('pendente')).toBe(3);
      expect(await blacklisted()).toBe(0);
      // Item da fila já está em erro (visível), mas a regra ainda não conta.
      expect(await item(1)).toMatchObject({ status: 'enviado', entrega_pendente_131026: true });
      expect(await metrics()).toMatchObject({ total_erros: 0 });
    });

    it('item aguardando confirmação NÃO é reenviado pelo retry (sem mensagem duplicada)', async () => {
      await sentItem(1, 'wamid.nr');
      await status('wamid.nr', 'failed', err131026);
      await db.exec("UPDATE wacrm.disp_message_queue SET sent_at = now() - interval '2 hours', updated_at = now() - interval '2 hours'");
      const retry = await db.query<{ n: number }>('SELECT wacrm.retry_transient_queue_errors() AS n');
      expect(retry.rows[0].n).toBe(0);
      expect((await item(1)).status).toBe('enviado');
      // failed repetido para o mesmo wamid não duplica a ocorrência.
      expect((await status('wamid.nr', 'failed', err131026)).rows[0].changed).toBe(false);
      expect(await failures()).toBe(1);
    });

    it('legado: item já em erro por 131026 (antes da 172) volta com delivered/read', async () => {
      await sentItem(1, 'wamid.old');
      await db.exec(`
        UPDATE wacrm.disp_message_queue
        SET status='erro', erro='${err131026}', erro_permanente=true WHERE id='${id(1)}';
        UPDATE wacrm.campaign_metrics SET total_erros = 1;
      `);
      expect((await status('wamid.old', 'read')).rows[0].changed).toBe(true);
      expect(await item(1)).toMatchObject({ status: 'lido', erro: null, erro_permanente: false });
      expect(await metrics()).toMatchObject({ total_erros: 0, total_lidos: 1 });
    });

    it('janela não vencida: nada é confirmado; vencida: pendente → confirmado com confirmed_at', async () => {
      await sentItem(1, 'wamid.p');
      await status('wamid.p', 'failed', err131026);
      expect(await confirmPending(1440)).toBe(0);
      expect(await failuresBy('pendente')).toBe(1);
      // Janela padrão (24h): com 23h ainda aguarda; só depois de 24h confirma.
      await db.exec("UPDATE wacrm.dispatch_meta_131026_failures SET created_at = now() - interval '23 hours'");
      expect(await confirmPending(1440)).toBe(0);
      await db.exec("UPDATE wacrm.dispatch_meta_131026_failures SET created_at = now() - interval '25 hours'");
      expect(await confirmPending(1440)).toBe(1);
      // Agora é erro definitivo e permanente, contado em total_erros.
      expect(await item(1)).toMatchObject({ status: 'erro', erro_permanente: true, entrega_pendente_131026: false });
      expect((await item(1)).erro).toContain('131026');
      expect(await metrics()).toMatchObject({ total_erros: 1 });
      const row = await db.query<{ status: string; confirmed_at: string | null }>(
        'SELECT status, confirmed_at FROM wacrm.dispatch_meta_131026_failures'
      );
      expect(row.rows[0].status).toBe('confirmado');
      expect(row.rows[0].confirmed_at).not.toBeNull();
      // Idempotente: nada mais a confirmar.
      expect(await confirmPending(1440)).toBe(0);
    });

    it('pendente → falso positivo: delivered antes da janela; o cron não confirma depois', async () => {
      await sentItem(1, 'wamid.q');
      await status('wamid.q', 'failed', err131026);
      await status('wamid.q', 'delivered');
      expect(await failuresBy('falso_positivo')).toBe(1);
      expect(await confirmPending()).toBe(0);
      expect(await failuresBy('falso_positivo')).toBe(1);
    });

    it('regra das 3 campanhas só considera confirmados (2 confirmados + 1 falso positivo + 1 pendente = sem bloqueio)', async () => {
      const c3 = '00000000-0000-0000-0000-000000000213';
      await db.exec(`INSERT INTO wacrm.campaigns(id, account_id, status) VALUES ('${c3}', '${account}', 'em_execucao')`);
      await sentItem(1, 'wamid.1', campaign);
      await sentItem(2, 'wamid.2', camp(1));
      await sentItem(3, 'wamid.3', camp(2));
      await sentItem(4, 'wamid.4', c3);
      for (const w of ['wamid.1', 'wamid.2', 'wamid.3']) await status(w, 'failed', err131026);
      await status('wamid.3', 'read'); // falso positivo
      await confirmPending(); // confirma 1 e 2 (3 já é falso positivo)
      await status('wamid.4', 'failed', err131026); // pendente
      expect(await failuresBy('confirmado')).toBe(2);
      expect(await failuresBy('pendente')).toBe(1);
      expect(await blacklisted()).toBe(0);
      // Confirmando a pendente chega a 3 confirmados → bloqueio.
      await confirmPending();
      expect(await failuresBy('confirmado')).toBe(3);
      expect(await blacklisted()).toBe(1);
    });

    it('erro síncrono no envio (record_meta_131026_failure) confirma na hora e usa a mesma regra', async () => {
      for (const c of [campaign, camp(1), camp(2)]) {
        await db.query('SELECT * FROM wacrm.record_meta_131026_failure($1,$2,$3)', [account, phone, c]);
      }
      expect(await failuresBy('confirmado')).toBe(3);
      expect(await blacklisted()).toBe(1);
    });

    it('telemetria: view meta_131026_stats por dia e campanha', async () => {
      await sentItem(1, 'wamid.1', campaign);
      await sentItem(2, 'wamid.2', camp(1));
      await sentItem(3, 'wamid.3', camp(2));
      for (const w of ['wamid.1', 'wamid.2', 'wamid.3']) await status(w, 'failed', err131026);
      await status('wamid.2', 'read');
      await db.exec(`UPDATE wacrm.dispatch_meta_131026_failures SET status='confirmado' WHERE campaign_id='${campaign}'`);
      const rows = await db.query<{ campaign_id: string; pendentes: number; confirmados: number; falsos_positivos: number }>(
        'SELECT campaign_id, pendentes, confirmados, falsos_positivos FROM wacrm.meta_131026_stats ORDER BY campaign_id'
      );
      expect(rows.rows).toEqual([
        { campaign_id: campaign, pendentes: 0, confirmados: 1, falsos_positivos: 0 },
        { campaign_id: camp(1), pendentes: 0, confirmados: 0, falsos_positivos: 1 },
        { campaign_id: camp(2), pendentes: 1, confirmados: 0, falsos_positivos: 0 },
      ]);
    });
  });

  describe('blacklist da regra das 3 campanhas', () => {
    /** 3 campanhas com 131026 para o mesmo telefone → bloqueio automático. */
    async function threeFailures() {
      await sentItem(1, 'wamid.1', campaign);
      await sentItem(2, 'wamid.2', camp(1));
      await sentItem(3, 'wamid.3', camp(2));
      for (const w of ['wamid.1', 'wamid.2', 'wamid.3']) await status(w, 'failed', err131026);
      // Provisórias até a janela passar sem delivered/read.
      expect(await confirmPending()).toBe(3);
    }

    it('read numa das 3 desfaz o bloqueio de origem 131026 (fica com 2 campanhas)', async () => {
      await threeFailures();
      expect(await failures()).toBe(3);
      expect(await blacklisted()).toBe(1);

      await status('wamid.2', 'read');
      expect(await failuresBy('confirmado')).toBe(2);
      expect(await failuresBy('falso_positivo')).toBe(1);
      expect(await blacklisted()).toBe(0);
      const rows = await db.query<{ campaign_id: string }>(
        "SELECT campaign_id FROM wacrm.dispatch_meta_131026_failures WHERE status='falso_positivo'"
      );
      expect(rows.rows.map((r) => r.campaign_id)).toEqual([camp(1)]);
    });

    it('bloqueio humano/opt-out do mesmo telefone nunca é removido', async () => {
      await sentItem(1, 'wamid.1', campaign);
      await sentItem(2, 'wamid.2', camp(1));
      // Humano bloqueou antes: o ON CONFLICT da regra não sobrescreve.
      await db.exec(`
        INSERT INTO wacrm.blacklist(telefone, account_id, motivo, bloqueado_por, data_bloqueio)
        VALUES ('${phone}', '${account}', 'Pediu para sair (opt-out)', 'humano', now())
      `);
      await status('wamid.1', 'failed', err131026);
      await status('wamid.2', 'failed', err131026);
      await confirmPending();
      await status('wamid.1', 'read');
      expect(await failuresBy('falso_positivo')).toBe(1);
      const rows = await db.query<{ bloqueado_por: string }>('SELECT bloqueado_por FROM wacrm.blacklist');
      expect(rows.rows).toEqual([{ bloqueado_por: 'humano' }]);
    });

    it('sistema com outro motivo (não 131026) também permanece', async () => {
      await threeFailures();
      await db.exec(`UPDATE wacrm.blacklist SET motivo = 'Palavra-chave de opt-out'`);
      await status('wamid.1', 'read');
      expect(await blacklisted()).toBe(1);
    });

    it('com 4 campanhas, remover uma ainda deixa ≥3 e mantém o bloqueio', async () => {
      await threeFailures();
      const extra = '00000000-0000-0000-0000-000000000213';
      await db.exec(`INSERT INTO wacrm.campaigns(id, account_id, status) VALUES ('${extra}', '${account}', 'em_execucao')`);
      await sentItem(4, 'wamid.4', extra);
      await status('wamid.4', 'failed', err131026);
      await confirmPending();
      expect(await failuresBy('confirmado')).toBe(4);
      await status('wamid.1', 'delivered');
      expect(await failuresBy('confirmado')).toBe(3);
      expect(await blacklisted()).toBe(1);
    });
  });
});
