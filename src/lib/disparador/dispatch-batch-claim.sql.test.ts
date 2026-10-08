// Migration 188 (P1-3b): claim e confirmação em lote, com as funções REAIS (118/125/167 + 188) em PGlite.
// PGlite tem uma conexão só: a exclusão entre claims concorrentes é provada pelo estado ('enviando' + SKIP LOCKED no corpo) — o teste de duas
// sessões reais precisa de um Postgres de verdade (bancada de carga).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const account = '00000000-0000-0000-0000-000000000001';
const camp = '00000000-0000-0000-0000-000000000011';
const camp2 = '00000000-0000-0000-0000-000000000012';
const ch = '00000000-0000-0000-0000-000000000021';
const ch2 = '00000000-0000-0000-0000-000000000022';
let db: PGlite;

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
const one = async <T = unknown>(sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0].v;
const count = async (sql: string, params: unknown[] = []) => Number(await one<string>(sql, params));
const claimBatch = async (session: string, n: number, campaigns: string[], def: number | null = null) =>
  (await db.query<{ item: { id: string; status: string; contacts: { phone: string } | null } }>(
    'SELECT item FROM wacrm.claim_dispatch_batch($1::uuid, $2, $3::uuid[], $4)',
    [session, n, `{${campaigns.join(',')}}`, def]
  )).rows.map((r) => r.item);
const statusCount = (c: string, status: string) =>
  count('SELECT count(*) AS v FROM wacrm.disp_message_queue WHERE campaign_id=$1 AND status=$2', [c, status]);

describe('migration 188 — claim e confirmação em lote', () => {
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
    for (const file of ['118_dispatch_safety.sql', '125_pending_dispatch_receipts.sql', '159_dispatch_auto_pause_receipts_cleanup.sql', '164_dispatch_throughput.sql', '167_dispatch_claim_o1_retry_receipts.sql']) {
      await db.exec(migration(file));
    }
    const sql = migration('188_dispatch_batch_claim_confirm.sql');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE wacrm.disp_message_queue, wacrm.dispatch_channel_limits, wacrm.dispatch_status_receipts, wacrm.messages,
        wacrm.message_logs, wacrm.campaign_metrics, wacrm.contacts;
      DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns(id, account_id, status, limite_por_hora) VALUES
        ('${camp}', '${account}', 'em_execucao', NULL), ('${camp2}', '${account}', 'em_execucao', NULL);
    `);
  });

  const seed = (c: string, session: string, n: number, extra = '', scheduled = "now() - interval '1 minute'") =>
    db.exec(`
      INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, status, scheduled_at, mensagem_final)
      SELECT gen_random_uuid(), '${c}', '${account}', '${session}', 'agendado', ${scheduled}, '55119' || lpad(g::text, 8, '0')
      FROM generate_series(1, ${n}) g ${extra};
    `);

  describe('claim_dispatch_batch', () => {
    it('reivindica N itens vencidos de uma vez, em ordem, devolvendo a linha com o contato embutido', async () => {
      await db.exec(`INSERT INTO wacrm.contacts VALUES ('00000000-0000-0000-0000-0000000000c1', 'Ana', '5511999990001', 'ACME')`);
      await db.exec(`
        INSERT INTO wacrm.disp_message_queue(id, campaign_id, account_id, session_id, contact_id, status, scheduled_at)
        VALUES ('00000000-0000-0000-0000-00000000d001', '${camp}', '${account}', '${ch}', '00000000-0000-0000-0000-0000000000c1', 'agendado', now() - interval '2 minutes')`);
      await seed(camp, ch, 9);
      const items = await claimBatch(ch, 5, [camp], 20);
      expect(items).toHaveLength(5);
      expect(items[0].id).toBe('00000000-0000-0000-0000-00000000d001'); // o mais antigo primeiro
      expect(items[0].contacts).toEqual({ name: 'Ana', phone: '5511999990001', company: 'ACME' });
      expect(items.every((i) => i.status === 'enviando')).toBe(true);
      expect(await statusCount(camp, 'enviando')).toBe(5);
      expect(await statusCount(camp, 'agendado')).toBe(5);
    });

    it('dois claims seguidos NUNCA pegam o mesmo item (nem em campanhas/números concorrentes do mesmo lote)', async () => {
      await seed(camp, ch, 30);
      const a = await claimBatch(ch, 10, [camp], 100);
      const b = await claimBatch(ch, 10, [camp], 100);
      const c = await claimBatch(ch, 50, [camp], 100);
      const ids = [...a, ...b, ...c].map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(30);
      expect(await count("SELECT count(*) AS v FROM pg_proc WHERE proname='claim_dispatch_batch' AND prosrc ILIKE '%SKIP LOCKED%'")).toBe(1);
    });

    it('só itens vencidos do número pedido; ignora futuros, outros números e sem número', async () => {
      await seed(camp, ch, 3);
      await seed(camp, ch, 4, '', "now() + interval '1 hour'");
      await seed(camp, ch2, 5);
      expect(await claimBatch(ch, 50, [camp], 100)).toHaveLength(3);
      expect(await claimBatch(ch2, 50, [camp], 100)).toHaveLength(5);
    });

    it('respeita max_in_flight (linha do canal e padrão do app, incluindo 150) contando os já em envio', async () => {
      await seed(camp, ch, 40);
      await db.exec(`INSERT INTO wacrm.dispatch_channel_limits(session_id, max_in_flight) VALUES ('${ch}', 12)`);
      expect(await claimBatch(ch, 50, [camp], 100)).toHaveLength(12); // linha vence o padrão
      expect(await claimBatch(ch, 50, [camp], 100)).toHaveLength(0); // cheio
      // padrão do app (sem linha), faixa 1..150 na 186; aqui fora da faixa cai para 4
      await db.exec(`DELETE FROM wacrm.dispatch_channel_limits; UPDATE wacrm.disp_message_queue SET status='agendado' WHERE status='enviando'`);
      expect(await claimBatch(ch, 50, [camp], 151)).toHaveLength(4);
      await db.exec(`UPDATE wacrm.disp_message_queue SET status='agendado' WHERE status='enviando'`);
      expect(await claimBatch(ch, 50, [camp], 30)).toHaveLength(30);
    });

    it('limite_por_hora da campanha: mesma regra do claim por item (enviando + enviados na última hora)', async () => {
      await db.exec(`UPDATE wacrm.campaigns SET limite_por_hora = 8 WHERE id = '${camp}'`);
      await seed(camp, ch, 30);
      await db.exec(`
        INSERT INTO wacrm.disp_message_queue(id, campaign_id, session_id, status, sent_at)
        VALUES (gen_random_uuid(), '${camp}', '${ch}', 'enviado', now() - interval '10 minutes'),
               (gen_random_uuid(), '${camp}', '${ch}', 'enviado', now() - interval '10 minutes'),
               (gen_random_uuid(), '${camp}', '${ch}', 'enviado', now() - interval '3 hours')`);
      // 2 na última hora + os que forem reivindicados ≤ 8 → 6 itens
      expect(await claimBatch(ch, 50, [camp], 100)).toHaveLength(6);
      expect(await claimBatch(ch, 50, [camp], 100)).toHaveLength(0);
      // O claim por item concorda: nada mais passa.
      const one_ = await one<string>(`SELECT id AS v FROM wacrm.disp_message_queue WHERE campaign_id='${camp}' AND status='agendado' LIMIT 1`);
      expect(await one<boolean>('SELECT wacrm.claim_dispatch_item_capped($1::uuid, 100) AS v', [one_])).toBe(false);
    });

    it('hourly_limit do canal vale para o lote inteiro', async () => {
      await seed(camp, ch, 30);
      await db.exec(`INSERT INTO wacrm.dispatch_channel_limits(session_id, max_in_flight, hourly_limit) VALUES ('${ch}', 50, 7)`);
      expect(await claimBatch(ch, 50, [camp], 100)).toHaveLength(7);
    });

    it('campanha pausada/encerrada não é reivindicada (o freio vale)', async () => {
      await seed(camp, ch, 10);
      await db.exec(`UPDATE wacrm.campaigns SET status = 'pausada' WHERE id = '${camp}'`);
      expect(await claimBatch(ch, 50, [camp], 100)).toHaveLength(0);
      expect(await statusCount(camp, 'enviando')).toBe(0);
    });

    it('várias campanhas no mesmo lote: preenche na ordem recebida, sem passar de N', async () => {
      await seed(camp, ch, 3);
      await seed(camp2, ch, 10);
      const items = await claimBatch(ch, 8, [camp, camp2], 100);
      expect(items).toHaveLength(8);
      expect(await statusCount(camp, 'enviando')).toBe(3);
      expect(await statusCount(camp2, 'enviando')).toBe(5);
    });

    it('item já com waha_message_id (aceito pelo provedor) nunca é reivindicado', async () => {
      await seed(camp, ch, 1);
      await db.exec(`UPDATE wacrm.disp_message_queue SET waha_message_id = 'wamid.X'`);
      expect(await claimBatch(ch, 5, [camp], 100)).toHaveLength(0);
    });

    it('count_due_dispatch_items conta vencidos por campanha×número (limitado) e unclaim devolve o não enviado', async () => {
      await seed(camp, ch, 7);
      await seed(camp, ch2, 2);
      await seed(camp, ch, 5, '', "now() + interval '1 hour'");
      const rows = (await db.query<{ campaign_id: string; session_id: string; n: number }>(
        `SELECT * FROM wacrm.count_due_dispatch_items('{${camp}}'::uuid[], 5000) ORDER BY n DESC`
      )).rows;
      expect(rows.map((r) => [r.session_id, r.n])).toEqual([[ch, 7], [ch2, 2]]);
      const limited = (await db.query<{ n: number }>(`SELECT * FROM wacrm.count_due_dispatch_items('{${camp}}'::uuid[], 4)`)).rows;
      expect(limited.reduce((a, r) => a + r.n, 0)).toBe(4);

      const items = await claimBatch(ch, 5, [camp], 100);
      await db.exec(`UPDATE wacrm.disp_message_queue SET waha_message_id = 'wamid.ENVIADO' WHERE id = '${items[0].id}'`);
      const released = await one<number>('SELECT wacrm.unclaim_dispatch_items($1::uuid[]) AS v', [`{${items.map((i) => i.id).join(',')}}`]);
      expect(Number(released)).toBe(4); // o que já tem waha_message_id (aceito) NÃO volta
      expect(await statusCount(camp, 'enviando')).toBe(1);
    });
  });

  describe('confirm_dispatch_items_sent', () => {
    const args = (id: string, session: string, wamid: string) => ({
      p_item_id: id, p_campaign_id: camp, p_contact_id: null, p_session_id: session,
      p_mensagem: 'Olá ' + wamid, p_waha_message_id: wamid, p_tentativas: 1,
    });
    async function claimed(n: number, session = ch) {
      await seed(camp, session, n);
      return (await claimBatch(session, n, [camp], 150)).map((i) => i.id);
    }
    const snapshot = async () => ({
      status: (await db.query<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM wacrm.disp_message_queue GROUP BY 1 ORDER BY 1`)).rows,
      logs: await count('SELECT count(*) AS v FROM wacrm.message_logs'),
      metrics: (await db.query(`SELECT total_enviados, total_entregues, total_lidos FROM wacrm.campaign_metrics`)).rows,
    });

    it('equivale à confirmação unitária: status, message_logs, métricas e replay de recibos antecipados', async () => {
      // Referência: unitário
      const ids1 = await claimed(6);
      await db.exec(`INSERT INTO wacrm.dispatch_status_receipts(message_id, status) VALUES ('wamid.U0','delivered'), ('wamid.U1','read'), ('wamid.U1','delivered')`);
      for (const [i, id] of ids1.entries()) {
        const a = args(id, ch, `wamid.U${i}`);
        await db.query('SELECT wacrm.confirm_dispatch_item_sent($1,$2,$3,$4,$5,$6,$7)', Object.values(a));
      }
      const unit = await snapshot();

      // Lote
      await db.exec(`TRUNCATE wacrm.disp_message_queue, wacrm.message_logs, wacrm.campaign_metrics, wacrm.dispatch_status_receipts`);
      const ids2 = await claimed(6);
      await db.exec(`INSERT INTO wacrm.dispatch_status_receipts(message_id, status) VALUES ('wamid.U0','delivered'), ('wamid.U1','read'), ('wamid.U1','delivered')`);
      const result = JSON.parse(
        JSON.stringify(await one('SELECT wacrm.confirm_dispatch_items_sent($1::jsonb) AS v', [JSON.stringify(ids2.map((id, i) => args(id, ch, `wamid.U${i}`)))]))
      ) as Array<{ ok: boolean; item_id: string }>;
      expect(result.map((r) => r.ok)).toEqual([true, true, true, true, true, true]);
      expect(result.map((r) => r.item_id)).toEqual(ids2); // mesma ordem da entrada
      expect(await snapshot()).toEqual(unit);
      expect(await count("SELECT count(*) AS v FROM wacrm.disp_message_queue WHERE status IN ('entregue','lido')")).toBe(2);
      expect(await count('SELECT count(*) AS v FROM wacrm.dispatch_status_receipts')).toBe(0);
    });

    it('um item inválido não derruba os outros (subtransação) e volta ok=false com o motivo', async () => {
      const ids = await claimed(3);
      const items = [
        args(ids[0], ch, 'wamid.A0'),
        { ...args(ids[1], ch, 'wamid.A1'), p_campaign_id: camp2 }, // identidade não confere
        args(ids[2], ch, 'wamid.A2'),
      ];
      const out = JSON.parse(JSON.stringify(await one('SELECT wacrm.confirm_dispatch_items_sent($1::jsonb) AS v', [JSON.stringify(items)]))) as Array<{ ok: boolean; error: string | null }>;
      expect(out.map((r) => r.ok)).toEqual([true, false, true]);
      expect(out[1].error).toMatch(/identity mismatch/i);
      expect(await statusCount(camp, 'enviado')).toBe(2);
      expect(await statusCount(camp, 'enviando')).toBe(1);
      expect(await count('SELECT count(*) AS v FROM wacrm.message_logs')).toBe(2);
    });

    it('crash no meio do lote não duplica: transação desfeita deixa tudo como estava e o reenvio da confirmação grava UMA vez', async () => {
      const ids = await claimed(5);
      const payload = JSON.stringify(ids.map((id, i) => args(id, ch, `wamid.C${i}`)));
      await db.exec('BEGIN');
      await db.query('SELECT wacrm.confirm_dispatch_items_sent($1::jsonb)', [payload]);
      await db.exec('ROLLBACK'); // processo caiu antes do commit
      expect(await count('SELECT count(*) AS v FROM wacrm.message_logs')).toBe(0);
      expect(await statusCount(camp, 'enviando')).toBe(5);
      await db.query('SELECT wacrm.confirm_dispatch_items_sent($1::jsonb)', [payload]);
      await db.query('SELECT wacrm.confirm_dispatch_items_sent($1::jsonb)', [payload]); // repetição idempotente
      expect(await count('SELECT count(*) AS v FROM wacrm.message_logs')).toBe(5);
      expect(await statusCount(camp, 'enviado')).toBe(5);
      expect(Number(await one<number>(`SELECT total_enviados AS v FROM wacrm.campaign_metrics WHERE campaign_id='${camp}'`))).toBe(5);
    });

    it('entrada vazia/inválida devolve lista vazia', async () => {
      expect(JSON.parse(JSON.stringify(await one('SELECT wacrm.confirm_dispatch_items_sent($1::jsonb) AS v', ['[]'])))).toEqual([]);
      expect(JSON.parse(JSON.stringify(await one('SELECT wacrm.confirm_dispatch_items_sent($1::jsonb) AS v', ['{}'])))).toEqual([]);
    });
  });

  it('permissões: só service_role executa', async () => {
    const r = await db.query<{ a: boolean; b: boolean; c: boolean; d: boolean }>(`
      SELECT has_function_privilege('authenticated', 'wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)', 'EXECUTE') AS a,
             has_function_privilege('authenticated', 'wacrm.confirm_dispatch_items_sent(jsonb)', 'EXECUTE') AS b,
             has_function_privilege('service_role', 'wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)', 'EXECUTE') AS c,
             has_function_privilege('service_role', 'wacrm.confirm_dispatch_items_sent(jsonb)', 'EXECUTE') AS d`);
    expect(r.rows[0]).toEqual({ a: false, b: false, c: true, d: true });
  });
});
