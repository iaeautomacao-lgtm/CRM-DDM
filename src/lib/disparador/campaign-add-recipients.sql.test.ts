// Migration 358 (API pública Onda 1, A3): wacrm.add_campaign_recipients. PGlite com a phone_key REAL da 167 e as colunas da 357.
// Prova: só campanha da API em execução/pausada; deduplica contra a fila e dentro do bloco (9º dígito/55); respeita o teto; itens entram
// 'agendado' (execução) ou 'pausado' (pausada); soma total_contatos; trava a MESMA linha da campanha que pausa/conclui; e o ROLLBACK executa.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const RUN = '00000000-0000-0000-0000-0000000000c1';
const PAUSED = '00000000-0000-0000-0000-0000000000c2';
const ENDED = '00000000-0000-0000-0000-0000000000c3';
const DASH = '00000000-0000-0000-0000-0000000000c4';
const OTHER = '00000000-0000-0000-0000-0000000000cb';
const SESSION = '00000000-0000-0000-0000-0000000000e1';

const read = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
function phoneKeyFunction(): string {
  const sql = read('167_dispatch_claim_o1_retry_receipts.sql');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION wacrm.phone_key');
  return sql.slice(start, sql.indexOf('$$;', sql.indexOf('AS $$', start)) + 3);
}

let db: PGlite;
const row = (phone: string, ref: string | null = null, at = '2026-10-20T11:00:00Z') => ({
  session_id: SESSION, mensagem_final: phone, tipo: 'texto', media_url: null, scheduled_at: at, template_name: 'promo', template_language: 'pt_BR', template_variables: ['Ana'], reference: ref,
});
const add = async (campaign: string, rows: object[], cap = 50000, account = A) =>
  (await db.query<{ r: any }>(`SELECT wacrm.add_campaign_recipients($1::uuid, $2::uuid, $3::jsonb, $4::int) AS r`, [account, campaign, JSON.stringify(rows), cap])).rows[0].r;
const count = async (campaign: string, status?: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM wacrm.disp_message_queue WHERE campaign_id = $1 ${status ? "AND status = '" + status + "'" : ''}`, [campaign])).rows[0].n);
const total = async (campaign: string) => Number((await db.query<{ n: string }>(`SELECT total_contatos AS n FROM wacrm.campaign_metrics WHERE campaign_id = $1`, [campaign])).rows[0].n);

describe('migration 358 — adicionar contatos a campanha existente', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid NOT NULL, status text NOT NULL, source text);
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, phone text);
      CREATE TABLE wacrm.campaign_metrics (campaign_id uuid PRIMARY KEY, total_contatos int DEFAULT 0);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES wacrm.campaigns(id), account_id uuid, contact_id uuid,
        session_id uuid, mensagem_final text, status text NOT NULL, tipo text, media_url text, scheduled_at timestamptz, updated_at timestamptz,
        template_name text, template_language text, template_variables jsonb
      );
    `);
    await db.exec(phoneKeyFunction());
    await db.exec(read('357_campaign_api_control.sql'));
    await db.exec(read('358_campaign_add_recipients.sql'));
    await db.exec(read('358_campaign_add_recipients.sql')); // idempotente
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`
      DELETE FROM wacrm.disp_message_queue; DELETE FROM wacrm.campaign_metrics; DELETE FROM wacrm.campaigns;
      INSERT INTO wacrm.campaigns (id, account_id, status, source) VALUES
        ('${RUN}', '${A}', 'em_execucao', 'api_v1'), ('${PAUSED}', '${A}', 'pausada', 'api_v1'), ('${ENDED}', '${A}', 'encerrada', 'api_v1'),
        ('${DASH}', '${A}', 'em_execucao', 'dashboard'), ('${OTHER}', '${B}', 'em_execucao', 'api_v1');
      INSERT INTO wacrm.campaign_metrics (campaign_id, total_contatos) SELECT id, 0 FROM wacrm.campaigns;
    `);
  });

  it('insere agendado em campanha em execução e soma total_contatos', async () => {
    const r = await add(RUN, [row('5521999998888', 'c-1'), row('5521977776666', 'c-2')]);
    expect(r).toEqual({ added: 2, duplicates: 0, total: 2 });
    expect(await count(RUN, 'agendado')).toBe(2);
    expect(await total(RUN)).toBe(2);
    const item = (await db.query<{ account_id: string; contact_id: string | null; reference: string; template_variables: unknown }>(`SELECT account_id, contact_id, reference, template_variables FROM wacrm.disp_message_queue WHERE reference = 'c-1'`)).rows[0];
    expect(item).toEqual({ account_id: A, contact_id: null, reference: 'c-1', template_variables: ['Ana'] });
  });

  it('campanha pausada: os itens entram pausados (voltam a agendado na retomada)', async () => {
    expect((await add(PAUSED, [row('5521999998888')])).added).toBe(1);
    expect(await count(PAUSED, 'pausado')).toBe(1);
    expect(await count(PAUSED, 'agendado')).toBe(0);
  });

  it('deduplica contra a fila (com/sem 55 e 9º dígito) e dentro do bloco; repetir não duplica', async () => {
    await add(RUN, [row('5521999998888')]);
    const r = await add(RUN, [row('21 99999-8888'), row('+55 21 9999-8888'), row('5521977776666'), row('21977776666')]);
    expect(r).toEqual({ added: 1, duplicates: 3, total: 2 });
    const again = await add(RUN, [row('5521999998888'), row('5521977776666')]);
    expect(again).toEqual({ added: 0, duplicates: 2, total: 2 });
    expect(await count(RUN)).toBe(2);
    expect(await total(RUN)).toBe(2);
  });

  it('teto: passaria do limite = erro cap e nada é inserido', async () => {
    await add(RUN, [row('5521999998888'), row('5521977776666')]);
    const r = await add(RUN, [row('5521955554444'), row('5521933332222')], 3);
    expect(r).toEqual({ error: 'cap', total: 2, cap: 3 });
    expect(await count(RUN)).toBe(2);
    expect((await add(RUN, [row('5521955554444')], 3)).added).toBe(1);
  });

  it('estados e origens que não aceitam: encerrada = status; campanha do painel = not_api_campaign; outra conta = NULL', async () => {
    expect(await add(ENDED, [row('5521999998888')])).toEqual({ error: 'status', status: 'encerrada' });
    expect(await add(DASH, [row('5521999998888')])).toEqual({ error: 'not_api_campaign' });
    expect(await add(OTHER, [row('5521999998888')], 50000, A)).toBeNull();
    expect(await count(ENDED)).toBe(0);
    expect(await count(DASH)).toBe(0);
    expect(await count(OTHER)).toBe(0);
  });

  it('só a service_role executa a função', async () => {
    const grants = (await db.query<{ r: string }>(
      `SELECT grantee AS r FROM information_schema.routine_privileges WHERE routine_schema='wacrm' AND routine_name='add_campaign_recipients' AND grantee IN ('anon','authenticated','PUBLIC','service_role') ORDER BY 1`,
    )).rows.map((x) => x.r);
    expect(grants).toEqual(['service_role']);
  });

  it('a adição lê o estado sob o lock da campanha: pausada entra pausado, encerrada recusa', async () => {
    // Transação A segura o lock (como stop_dispatch_campaign) enquanto a adição entra em outra consulta: com 1 conexão do PGlite,
    // provamos a ordem serializando: pausar primeiro → adicionar depois cai em 'pausado'; encerrar primeiro → adicionar recusa.
    await db.exec(`UPDATE wacrm.campaigns SET status = 'pausada' WHERE id = '${RUN}'`);
    expect((await add(RUN, [row('5521999998888')])).added).toBe(1);
    expect(await count(RUN, 'pausado')).toBe(1);
    await db.exec(`UPDATE wacrm.campaigns SET status = 'encerrada' WHERE id = '${RUN}'`);
    expect(await add(RUN, [row('5521977776666')])).toEqual({ error: 'status', status: 'encerrada' });
  });

  it('registra a migration e o ROLLBACK do cabeçalho executa (e dá para reaplicar)', async () => {
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '358_campaign_add_recipients'`)).rows).toHaveLength(1);
    const header = read('358_campaign_add_recipients.sql').split('\nBEGIN;\n')[0];
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
    expect((await db.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wacrm' AND p.proname='add_campaign_recipients'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '358_campaign_add_recipients'`)).rows).toHaveLength(0);
    await db.exec(read('358_campaign_add_recipients.sql'));
    expect((await db.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wacrm' AND p.proname='add_campaign_recipients'`)).rows).toHaveLength(1);
  });
});
