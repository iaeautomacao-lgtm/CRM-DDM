// Migration 185 (P1-2): webhook de status durável e em lote. PGlite com 112…172 + 183 + 185 reais.
// Cobre: duplicados, fora de ordem, failed→read (131026), lote de 500 eventos, tenancy (W1),
// messages/test_sends em lote, item 'enviando' (recibo), erro por item sem perder o lote,
// e "nenhum evento perdido se o processo cair entre o 200 e o apply" (o evento já está no inbox).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const account = '00000000-0000-0000-0000-000000000001';
const otherAccount = '00000000-0000-0000-0000-000000000002';
const campaign = '00000000-0000-0000-0000-000000000011';
const channel = '00000000-0000-0000-0000-000000000021';
const contact = '00000000-0000-0000-0000-000000000041';
const conversation = '00000000-0000-0000-0000-000000000051';
const phone = '+5511999998888';
const err131026 = 'Meta: Message undeliverable (code 131026)';
const uid = (n: number) => `00000000-0000-0000-0000-${String(1000000 + n).padStart(12, '0')}`;
let db: PGlite;

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');

type Ev = { message_id: string; status: string; error_text?: string | null; account_id?: string | null; ts?: number };
const ingest = async (events: Ev[]) =>
  (
    await db.query<{ n: number }>('SELECT wacrm.ingest_status_events($1::jsonb) AS n', [
      JSON.stringify(events.map((e) => ({ account_id: account, ts: 1_760_000_000, ...e }))),
    ])
  ).rows[0].n;
const apply = async (limit = 500) =>
  (await db.query<{ r: { claimed: number; fast: number; slow: number; failed: number } }>('SELECT wacrm.apply_dispatch_statuses($1) AS r', [limit]))
    .rows[0].r;
const item = async (n: number) =>
  (
    await db.query<{ status: string; erro: string | null; erro_permanente: boolean; entrega_pendente_131026: boolean }>(
      `SELECT status, erro, erro_permanente, entrega_pendente_131026 FROM wacrm.disp_message_queue WHERE id='${uid(n)}'`
    )
  ).rows[0];
const metrics = async () => {
  await db.exec('SELECT wacrm.consolidate_campaign_metrics(100000)');
  return (
    await db.query('SELECT total_enviados, total_entregues, total_lidos, total_erros FROM wacrm.campaign_metrics WHERE campaign_id=$1', [campaign])
  ).rows[0];
};
const inbox = async () =>
  (await db.query<{ message_id: string; status: string; processed: boolean; attempts: number }>(
    'SELECT message_id, status, processed_at IS NOT NULL AS processed, attempts FROM wacrm.webhook_status_inbox ORDER BY id'
  )).rows;
const deltaRows = async (field: string) =>
  (await db.query<{ n: number; rows: number }>(
    'SELECT coalesce(sum(n),0)::int AS n, count(*)::int AS rows FROM wacrm.campaign_metric_deltas WHERE field=$1', [field]
  )).rows[0];

async function sentItem(n: number, wamid: string, accountId = account) {
  await db.exec(`
    INSERT INTO wacrm.disp_message_queue(id,campaign_id,account_id,session_id,contact_id,status,scheduled_at)
    VALUES ('${uid(n)}','${campaign}','${accountId}','${channel}','${contact}','agendado',now() - interval '1 minute')
    ON CONFLICT (id) DO NOTHING;
  `);
  await db.query('SELECT wacrm.claim_dispatch_item_capped($1::uuid, 100)', [uid(n)]);
  await db.query('SELECT wacrm.confirm_dispatch_item_sent($1,$2,$3,$4,$5,$6,1)', [uid(n), campaign, contact, channel, 'olá', wamid]);
}

describe('migration 185 — webhook de status em lote', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
      CREATE TABLE wacrm.profiles (user_id uuid, account_id uuid, full_name text);
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, waha_session text);
      CREATE TABLE wacrm.campaigns (
        id uuid PRIMARY KEY, account_id uuid, status text, limite_por_hora int,
        batch_pause_seconds int, updated_at timestamptz, nome text, created_by uuid,
        created_at timestamptz DEFAULT now(), agendamento timestamptz, session_ids uuid[]
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
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text,
        message_id text UNIQUE, status text
      );
      CREATE TABLE wacrm.whatsapp_test_sends (message_id text, status text, erro text);
      CREATE TABLE wacrm.contact_import_variables (id serial PRIMARY KEY, campaign_id uuid, draft_id uuid);
      CREATE TABLE wacrm.message_logs (
        queue_id uuid, campaign_id uuid, contact_id uuid, session_id uuid,
        direcao text, mensagem text, status text, waha_message_id text
      );
      CREATE TABLE wacrm.campaign_metrics (
        campaign_id uuid PRIMARY KEY, account_id uuid, total_contatos int DEFAULT 0,
        total_enviados int DEFAULT 0, total_entregues int DEFAULT 0,
        total_lidos int DEFAULT 0, total_erros int DEFAULT 0, total_blacklist int DEFAULT 0,
        total_respostas int DEFAULT 0, tempo_medio_resposta int DEFAULT 0, updated_at timestamptz
      );
      CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role text DEFAULT 'viewer') RETURNS boolean
        LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO wacrm.campaign_metrics(campaign_id) VALUES (p_campaign_id) ON CONFLICT DO NOTHING;
        EXECUTE format('UPDATE wacrm.campaign_metrics SET %I=%I+1 WHERE campaign_id=$1', p_field, p_field)
        USING p_campaign_id;
      END $$;
      CREATE TABLE wacrm.system_logs (
        id serial PRIMARY KEY, account_id uuid, level text, source text, event text, message text, payload jsonb
      );
      INSERT INTO wacrm.accounts VALUES ('${account}'), ('${otherAccount}');
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
      '172_dispatch_status_precedence.sql',
      '183_campaign_metric_deltas.sql',
    ]) {
      await db.exec(migration(file));
    }
    const sql = migration('185_webhook_status_inbox.sql');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.dispatch_status_receipts, wacrm.messages, wacrm.conversations,
        wacrm.whatsapp_test_sends, wacrm.message_logs, wacrm.campaign_metrics, wacrm.campaign_metric_deltas,
        wacrm.blacklist, wacrm.contacts, wacrm.dispatch_meta_131026_failures, wacrm.system_logs,
        wacrm.webhook_status_inbox;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns(id, account_id, status) VALUES ('${campaign}', '${account}', 'em_execucao');
      INSERT INTO wacrm.campaign_metrics(campaign_id, account_id) VALUES ('${campaign}', '${account}');
      INSERT INTO wacrm.contacts VALUES ('${contact}', '${phone}');
      INSERT INTO wacrm.conversations VALUES ('${conversation}', '${account}');
    `);
  });

  it('só funciona a partir da service_role: sem EXECUTE para anon/authenticated', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query("SELECT wacrm.apply_dispatch_statuses(10)")).rejects.toThrow(/permission denied/);
        await expect(db.query("SELECT wacrm.ingest_status_events('[]'::jsonb)")).rejects.toThrow(/permission denied/);
        await expect(db.query('SELECT * FROM wacrm.webhook_status_inbox')).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec('RESET ROLE');
      }
    }
    const def = (await db.query<{ d: string }>("SELECT pg_get_functiondef('wacrm.apply_dispatch_statuses(integer)'::regprocedure) AS d")).rows[0].d;
    expect(def).toContain('FOR UPDATE SKIP LOCKED');
  });

  describe('ingestão', () => {
    it('duplicados da Meta são absorvidos (UNIQUE message_id,status); status inválido/sem id é ignorado', async () => {
      expect(await ingest([{ message_id: 'w1', status: 'delivered' }, { message_id: 'w1', status: 'delivered' }, { message_id: 'w1', status: 'read' }])).toBe(2);
      expect(await ingest([{ message_id: 'w1', status: 'delivered' }, { message_id: '', status: 'read' }, { message_id: 'w2', status: 'sent' }])).toBe(0);
      expect((await inbox()).length).toBe(2);
    });
  });

  describe('caminho comum em lote', () => {
    it('delivered → entregue e read → lido, métricas agregadas num delta por campanha/campo', async () => {
      await sentItem(1, 'w1');
      await sentItem(2, 'w2');
      await sentItem(3, 'w3');
      const before = await deltaRows('total_entregues');
      await ingest([
        { message_id: 'w1', status: 'delivered' },
        { message_id: 'w2', status: 'read' },
        { message_id: 'w3', status: 'delivered' },
      ]);
      expect(await apply()).toMatchObject({ claimed: 3, fast: 3, slow: 0, failed: 0 });
      expect((await item(1)).status).toBe('entregue');
      expect((await item(2)).status).toBe('lido');
      expect((await item(3)).status).toBe('entregue');
      expect(await metrics()).toMatchObject({ total_enviados: 3, total_entregues: 3, total_lidos: 1, total_erros: 0 });
      // Uma linha de delta por campo (não uma por evento).
      const after = await deltaRows('total_entregues');
      expect(after.rows - before.rows).toBeLessThanOrEqual(1);
      expect((await inbox()).every((r) => r.processed)).toBe(true);
    });

    it('precedência read > delivered em qualquer ordem, no mesmo lote ou em lotes separados', async () => {
      await sentItem(1, 'wa');
      await sentItem(2, 'wb');
      await sentItem(3, 'wc');
      await ingest([{ message_id: 'wa', status: 'delivered' }, { message_id: 'wa', status: 'read' }]);
      await ingest([{ message_id: 'wb', status: 'read' }, { message_id: 'wb', status: 'delivered' }]);
      await apply();
      expect((await item(1)).status).toBe('lido');
      expect((await item(2)).status).toBe('lido');
      // Lotes separados: read primeiro, delivered tardio não rebaixa.
      await ingest([{ message_id: 'wc', status: 'read' }]);
      await apply();
      await ingest([{ message_id: 'wc', status: 'delivered' }]);
      await apply();
      expect((await item(3)).status).toBe('lido');
      expect(await metrics()).toMatchObject({ total_enviados: 3, total_entregues: 3, total_lidos: 3 });
    });

    it('reprocessar o mesmo evento (Meta reenvia depois de aplicado) não duplica nada', async () => {
      await sentItem(1, 'w1');
      await ingest([{ message_id: 'w1', status: 'delivered' }]);
      await apply();
      expect(await ingest([{ message_id: 'w1', status: 'delivered' }])).toBe(0);
      expect(await apply()).toMatchObject({ claimed: 0 });
      expect(await metrics()).toMatchObject({ total_entregues: 1 });
    });

    it('lote de 500 eventos: tudo no caminho rápido, 1 delta por campo, nenhuma chamada por item', async () => {
      const events: Ev[] = [];
      for (let i = 1; i <= 500; i++) {
        await sentItem(i, `wl${i}`);
        events.push({ message_id: `wl${i}`, status: i % 2 ? 'read' : 'delivered' });
      }
      await ingest(events);
      const t0 = Date.now();
      const result = await apply(500);
      expect(result).toMatchObject({ claimed: 500, fast: 500, slow: 0, failed: 0 });
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(await metrics()).toMatchObject({ total_enviados: 500, total_entregues: 500, total_lidos: 250 });
      expect((await deltaRows('total_lidos')).rows).toBeLessThanOrEqual(1);
    });

    it('p_limit respeitado: o resto fica pendente e é drenado depois', async () => {
      for (let i = 1; i <= 5; i++) await sentItem(i, `wp${i}`);
      await ingest([1, 2, 3, 4, 5].map((i) => ({ message_id: `wp${i}`, status: 'delivered' })));
      expect(await apply(2)).toMatchObject({ claimed: 2 });
      expect((await inbox()).filter((r) => !r.processed)).toHaveLength(3);
      expect(await apply(10)).toMatchObject({ claimed: 3 });
      expect(await metrics()).toMatchObject({ total_entregues: 5 });
    });
  });

  describe('failed, 131026 e itens fora do caminho comum (função atual por item)', () => {
    it('failed depois de read no MESMO lote: item fica lido, sem erro', async () => {
      await sentItem(1, 'w1');
      await ingest([{ message_id: 'w1', status: 'failed', error_text: err131026 }, { message_id: 'w1', status: 'read' }]);
      expect(await apply()).toMatchObject({ claimed: 2, fast: 1 });
      expect(await item(1)).toMatchObject({ status: 'lido', erro: null, erro_permanente: false });
      expect(await metrics()).toMatchObject({ total_erros: 0, total_entregues: 1, total_lidos: 1 });
    });

    it('failed 131026 vira "aguardando confirmação"; read depois (outro lote) recupera como falso positivo', async () => {
      await sentItem(1, 'w1');
      await ingest([{ message_id: 'w1', status: 'failed', error_text: err131026 }]);
      expect(await apply()).toMatchObject({ claimed: 1, fast: 0, slow: 1 });
      expect(await item(1)).toMatchObject({ status: 'enviado', entrega_pendente_131026: true, erro_permanente: false });
      expect(await metrics()).toMatchObject({ total_erros: 0 });

      await ingest([{ message_id: 'w1', status: 'read' }]);
      expect(await apply()).toMatchObject({ claimed: 1, slow: 1 });
      expect(await item(1)).toMatchObject({ status: 'lido', erro: null, entrega_pendente_131026: false });
      expect((await db.query<{ status: string }>('SELECT status FROM wacrm.dispatch_meta_131026_failures')).rows).toEqual([{ status: 'falso_positivo' }]);
    });

    it('failed que não é 131026 vira erro permanente e conta total_erros', async () => {
      await sentItem(1, 'w1');
      await ingest([{ message_id: 'w1', status: 'failed', error_text: 'Meta: Re-engagement message (code 131047)' }]);
      await apply();
      expect(await item(1)).toMatchObject({ status: 'erro', erro_permanente: true });
      expect(await metrics()).toMatchObject({ total_erros: 1 });
    });

    it('item ainda "enviando" (confirmação local pendente): o recibo é guardado e aplicado no replay — nada se perde', async () => {
      await db.exec(`
        INSERT INTO wacrm.disp_message_queue(id,campaign_id,account_id,session_id,contact_id,status,scheduled_at)
        VALUES ('${uid(1)}','${campaign}','${account}','${channel}','${contact}','agendado',now() - interval '1 minute');
      `);
      await db.query('SELECT wacrm.claim_dispatch_item_capped($1::uuid, 100)', [uid(1)]);
      await ingest([{ message_id: 'wz', status: 'read' }]);
      await apply();
      expect((await inbox())[0].processed).toBe(true);
      expect((await db.query('SELECT 1 FROM wacrm.dispatch_status_receipts WHERE message_id=$1', ['wz'])).rows).toHaveLength(1);
      // A confirmação chega depois: replay aplica o read guardado.
      await db.query('SELECT wacrm.confirm_dispatch_item_sent($1,$2,$3,$4,$5,$6,1)', [uid(1), campaign, contact, channel, 'olá', 'wz']);
      expect((await item(1)).status).toBe('lido');
    });
  });

  describe('tenancy (W1)', () => {
    it('evento assinado pelo canal de OUTRA conta não altera item alheio (caminho rápido e por item)', async () => {
      await sentItem(1, 'w1'); // conta A
      await sentItem(2, 'w2');
      await ingest([
        { message_id: 'w1', status: 'read', account_id: otherAccount },
        { message_id: 'w2', status: 'failed', error_text: 'Meta: x (code 131047)', account_id: otherAccount },
      ]);
      await apply();
      expect((await item(1)).status).toBe('enviado');
      expect((await item(2)).status).toBe('enviado');
      expect(await metrics()).toMatchObject({ total_enviados: 2, total_entregues: 0, total_lidos: 0, total_erros: 0 });
      expect((await inbox()).every((r) => r.processed)).toBe(true);
    });

    it('a mesma conta aplica normalmente', async () => {
      await sentItem(1, 'w1');
      await ingest([{ message_id: 'w1', status: 'read', account_id: account }]);
      await apply();
      expect((await item(1)).status).toBe('lido');
    });
  });

  describe('messages (Inbox) e Testar canal em lote', () => {
    it('messages: mesmas transições do webhook, escopadas pela conta da conversa; test_sends condicional', async () => {
      await db.exec(`
        INSERT INTO wacrm.conversations VALUES ('${uid(900)}', '${otherAccount}');
        INSERT INTO wacrm.messages(conversation_id, sender_type, message_id, status) VALUES
          ('${conversation}', 'bot', 'mi1', 'sent'),
          ('${conversation}', 'bot', 'mi2', 'read'),
          ('${conversation}', 'bot', 'mi3', 'sent'),
          ('${uid(900)}',     'bot', 'mi4', 'sent');
        INSERT INTO wacrm.whatsapp_test_sends(message_id, status, erro) VALUES ('mt1', 'sent', NULL), ('mt2', 'delivered', NULL);
      `);
      await ingest([
        { message_id: 'mi1', status: 'delivered' },
        { message_id: 'mi2', status: 'delivered' }, // não rebaixa read
        { message_id: 'mi3', status: 'failed', error_text: 'x' },
        { message_id: 'mi4', status: 'read' }, // conversa de outra conta: intocada
        { message_id: 'mt1', status: 'failed', error_text: 'Meta: falha (code 1)' },
        { message_id: 'mt2', status: 'failed', error_text: 'Meta: falha (code 1)' }, // failed não sobrescreve delivered
      ]);
      await apply();
      const rows = (await db.query<{ message_id: string; status: string }>('SELECT message_id, status FROM wacrm.messages ORDER BY message_id')).rows;
      expect(Object.fromEntries(rows.map((r) => [r.message_id, r.status]))).toEqual({ mi1: 'delivered', mi2: 'read', mi3: 'failed', mi4: 'sent' });
      const tests = (await db.query<{ message_id: string; status: string; erro: string | null }>('SELECT * FROM wacrm.whatsapp_test_sends ORDER BY message_id')).rows;
      expect(tests).toEqual([
        { message_id: 'mt1', status: 'failed', erro: 'Meta: falha (code 1)' },
        { message_id: 'mt2', status: 'delivered', erro: null },
      ]);
    });

    it('status de mensagem do Inbox (sem item de campanha) não passa pela função de campanha', async () => {
      await db.exec(`INSERT INTO wacrm.messages(conversation_id, sender_type, message_id, status) VALUES ('${conversation}', 'bot', 'mi1', 'sent')`);
      await ingest([{ message_id: 'mi1', status: 'delivered' }]);
      expect(await apply()).toMatchObject({ claimed: 1, fast: 0, slow: 0 });
      expect((await db.query('SELECT count(*)::int AS n FROM wacrm.dispatch_status_receipts')).rows[0]).toEqual({ n: 0 });
    });
  });

  describe('robustez: erro num item não perde o lote nem o evento', () => {
    it('falha por item volta para a fila (attempts+1) e é descartada só após 5 tentativas; o resto do lote segue', async () => {
      await sentItem(1, 'wok');
      await db.exec(`
        CREATE OR REPLACE FUNCTION wacrm.apply_dispatch_status(p_message_id text, p_status text, p_error text DEFAULT NULL)
        RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
          IF p_message_id = 'wboom' THEN RAISE EXCEPTION 'falha simulada'; END IF;
          RETURN false;
        END $$;
      `);
      try {
        await ingest([{ message_id: 'wboom', status: 'failed', error_text: 'x' }, { message_id: 'wok', status: 'read' }]);
        expect(await apply()).toMatchObject({ claimed: 2, fast: 1, failed: 1 });
        // O evento bom foi aplicado; o ruim continua pendente (nada perdido).
        expect((await item(1)).status).toBe('lido');
        let rows = await inbox();
        expect(rows.find((r) => r.message_id === 'wboom')).toMatchObject({ processed: false, attempts: 1 });
        for (let i = 0; i < 4; i++) await apply();
        rows = await inbox();
        expect(rows.find((r) => r.message_id === 'wboom')).toMatchObject({ processed: true, attempts: 5 });
      } finally {
        // Restaura a função real da 172.
        await db.exec(migration('172_dispatch_status_precedence.sql'));
      }
    });

    it('processo cai entre o 200 e o apply: o evento já está no inbox e o próximo drenador (cron) aplica', async () => {
      await sentItem(1, 'w1');
      await ingest([{ message_id: 'w1', status: 'read' }]); // o 200 já foi dado; "o processo caiu" aqui
      expect((await item(1)).status).toBe('enviado');
      expect((await inbox()).filter((r) => !r.processed)).toHaveLength(1);
      expect(await apply()).toMatchObject({ claimed: 1, fast: 1 });
      expect((await item(1)).status).toBe('lido');
    });

    it('ocioso: poda o que foi processado há mais de 3 dias (e só isso)', async () => {
      await ingest([{ message_id: 'old', status: 'read' }, { message_id: 'new', status: 'read' }]);
      await apply();
      await db.exec(`UPDATE wacrm.webhook_status_inbox SET processed_at = now() - interval '4 days' WHERE message_id = 'old'`);
      expect(await apply()).toMatchObject({ claimed: 0 });
      expect((await inbox()).map((r) => r.message_id)).toEqual(['new']);
    });
  });

  describe('W3 — confirm_pending_meta_131026 mantém a regra da 172', () => {
    it('pendente vencido vira erro definitivo (+ total_erros) e sai de "aguardando"', async () => {
      await sentItem(1, 'w1');
      await ingest([{ message_id: 'w1', status: 'failed', error_text: err131026 }]);
      await apply();
      await db.exec("UPDATE wacrm.dispatch_meta_131026_failures SET created_at = created_at - interval '2 seconds' WHERE status='pendente'");
      expect((await db.query<{ n: number }>('SELECT wacrm.confirm_pending_meta_131026(0, 200) AS n')).rows[0].n).toBe(1);
      expect(await item(1)).toMatchObject({ status: 'erro', erro_permanente: true, entrega_pendente_131026: false });
      expect(await metrics()).toMatchObject({ total_erros: 1 });
    });
  });
});
