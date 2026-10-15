// Migration 357 (API pública Onda 1, A2): colunas novas e wacrm.remove_campaign_recipients. PGlite com a phone_key REAL da 167.
// Prova: remove só o que não foi enviado (agendado/pendente/pausado), por telefone (tolera 9º dígito e DDI), por referência e por contato do CRM;
// idempotente; in_flight/already_sent/not_found; não toca outra campanha nem outra conta; e o ROLLBACK do cabeçalho executa.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C1 = '00000000-0000-0000-0000-0000000000c1';
const C2 = '00000000-0000-0000-0000-0000000000c2';
const CB = '00000000-0000-0000-0000-0000000000cb';
const CONTACT = '00000000-0000-0000-0000-0000000000f1';

const read = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');

// A função phone_key da 167, sozinha (o resto da 167 depende de metade do motor).
function phoneKeyFunction(): string {
  const sql = read('167_dispatch_claim_o1_retry_receipts.sql');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION wacrm.phone_key');
  const end = sql.indexOf('$$;', sql.indexOf('AS $$', start)) + 3;
  return sql.slice(start, end);
}

let db: PGlite;
const rpc = async (campaign: string, keys: string[], refs: string[], reason = 'paid', account = A) =>
  (await db.query<{ r: any }>(`SELECT wacrm.remove_campaign_recipients($1::uuid, $2::uuid, $3::text[], $4::text[], $5) AS r`, [account, campaign, keys, refs, reason])).rows[0].r;
const k = async (raw: string) => (await db.query<{ k: string }>(`SELECT wacrm.phone_key($1) AS k`, [raw])).rows[0].k;
const item = async (id: string) => (await db.query<{ status: string; cancel_reason: string | null }>(`SELECT status, cancel_reason FROM wacrm.disp_message_queue WHERE id = $1`, [id])).rows[0];
const uid = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('migration 357 — controle de campanha pela API', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid NOT NULL, status text NOT NULL DEFAULT 'em_execucao');
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, phone text);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES wacrm.campaigns(id), account_id uuid, contact_id uuid, mensagem_final text,
        status text NOT NULL, updated_at timestamptz
      );
    `);
    await db.exec(phoneKeyFunction());
    await db.exec(read('357_campaign_api_control.sql'));
    await db.exec(read('357_campaign_api_control.sql')); // idempotente
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`
      DELETE FROM wacrm.disp_message_queue; DELETE FROM wacrm.campaigns; DELETE FROM wacrm.contacts;
      INSERT INTO wacrm.campaigns (id, account_id, status) VALUES ('${C1}', '${A}', 'em_execucao'), ('${C2}', '${A}', 'em_execucao'), ('${CB}', '${B}', 'em_execucao');
      INSERT INTO wacrm.contacts (id, phone) VALUES ('${CONTACT}', '+5521988887777');
    `);
    const rows: Array<[string, string, string | null, string | null, string, string | null]> = [
      // id, campanha, contact_id, mensagem_final (telefone do contato externo), status, reference
      [uid(1), C1, null, '5521999998888', 'agendado', 'contrato-1'],
      [uid(2), C1, null, '5521977776666', 'pausado', 'contrato-2'],
      [uid(3), C1, null, '5521955554444', 'enviando', 'contrato-3'],
      [uid(4), C1, null, '5521933332222', 'entregue', 'contrato-4'],
      [uid(5), C1, CONTACT, 'Olá, {{1}}', 'agendado', null],
      [uid(6), C2, null, '5521999998888', 'agendado', 'contrato-1'],
      [uid(7), CB, null, '5521999998888', 'agendado', 'contrato-1'],
    ];
    for (const [id, camp, contact, msg, status, ref] of rows) {
      await db.query(`INSERT INTO wacrm.disp_message_queue (id, campaign_id, account_id, contact_id, mensagem_final, status) VALUES ($1,$2,$3,$4,$5,$6)`, [id, camp, camp === CB ? B : A, contact, msg, status]);
      if (ref) await db.query(`UPDATE wacrm.disp_message_queue SET reference = $2 WHERE id = $1`, [id, ref]);
    }
  });

  it('remove por telefone e só o item agendado/pausado; devolve o estado de cada chave', async () => {
    const [k1, k2, k3, k4, k5] = [await k('5521999998888'), await k('5521977776666'), await k('5521955554444'), await k('5521933332222'), await k('5521900000000')];
    const res = await rpc(C1, [k1, k2, k3, k4, k5], []);
    expect(res.removed).toBe(2);
    expect(res.phones[k1]).toEqual({ status: 'removed', items: 1 });
    expect(res.phones[k2]).toEqual({ status: 'removed', items: 1 });
    expect(res.phones[k3]).toEqual({ status: 'in_flight', items: 1 });
    expect(res.phones[k4]).toEqual({ status: 'already_sent', items: 1 });
    expect(res.phones[k5]).toEqual({ status: 'not_found', items: 0 });
    expect(await item(uid(1))).toEqual({ status: 'cancelado', cancel_reason: 'removed_api:paid' });
    expect(await item(uid(2))).toMatchObject({ status: 'cancelado' });
    expect(await item(uid(3))).toMatchObject({ status: 'enviando', cancel_reason: null });
    expect(await item(uid(4))).toMatchObject({ status: 'entregue', cancel_reason: null });
  });

  it('a chave do telefone usa phone_key da 167: com ou sem o 9º dígito e o 55 resolve para a mesma pessoa', async () => {
    const key = await k('+55 21 99999-8888');
    expect(await k('21 9999-8888')).toBe(key);
    const res = await rpc(C1, [key], []);
    expect(res.phones[key].status).toBe('removed');
  });

  it('contato do CRM: casa pelo contacts.phone, nunca pelo texto da mensagem', async () => {
    const key = await k('+5521988887777');
    const res = await rpc(C1, [key], []);
    expect(res.phones[key]).toEqual({ status: 'removed', items: 1 });
    expect(await item(uid(5))).toMatchObject({ status: 'cancelado', cancel_reason: 'removed_api:paid' });
  });

  it('remove por referência', async () => {
    const res = await rpc(C1, [], ['contrato-2', 'inexistente']);
    expect(res.references['contrato-2']).toEqual({ status: 'removed', items: 1 });
    expect(res.references.inexistente).toEqual({ status: 'not_found', items: 0 });
  });

  it('idempotente: repetir devolve already_removed e não cancela de novo; o motivo da 1ª remoção fica', async () => {
    await rpc(C1, [await k('5521999998888')], [], 'paid');
    const key = await k('5521999998888');
    const again = await rpc(C1, [key], [], 'other');
    expect(again.removed).toBe(0);
    expect(again.phones[key]).toEqual({ status: 'already_removed', items: 1 });
    expect(await item(uid(1))).toMatchObject({ cancel_reason: 'removed_api:paid' });
  });

  it('item cancelado junto com a campanha (sem motivo de remoção) também é already_removed', async () => {
    await db.exec(`UPDATE wacrm.disp_message_queue SET status = 'cancelado' WHERE id = '${uid(1)}'`);
    const key = await k('5521999998888');
    const res = await rpc(C1, [key], []);
    expect(res.phones[key].status).toBe('already_removed');
  });

  it('não toca outra campanha da conta nem outra conta; campanha de outra conta = NULL', async () => {
    await rpc(C1, [await k('5521999998888')], ['contrato-1']);
    expect(await item(uid(6))).toMatchObject({ status: 'agendado' });
    expect(await item(uid(7))).toMatchObject({ status: 'agendado' });
    expect(await rpc(CB, [await k('5521999998888')], [], 'paid', A)).toBeNull();
    expect(await item(uid(7))).toMatchObject({ status: 'agendado' });
  });

  it('motivo vazio vira other; só a service_role executa a RPC', async () => {
    await rpc(C1, [await k('5521999998888')], [], '  ');
    expect(await item(uid(1))).toMatchObject({ cancel_reason: 'removed_api:other' });
    const grants = (await db.query<{ r: string }>(
      `SELECT grantee AS r FROM information_schema.routine_privileges WHERE routine_schema='wacrm' AND routine_name='remove_campaign_recipients' AND grantee IN ('anon','authenticated','PUBLIC','service_role') ORDER BY 1`,
    )).rows.map((x) => x.r);
    expect(grants).toEqual(['service_role']);
  });

  it('registra a migration', async () => {
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '357_campaign_api_control'`)).rows).toHaveLength(1);
  });

  it('o ROLLBACK do cabeçalho executa: some função, colunas e registro; e dá para reaplicar', async () => {
    const header = read('357_campaign_api_control.sql').split('\nBEGIN;\n')[0];
    const from = header.indexOf('-- ROLLBACK');
    const block = header
      .slice(from)
      .split('\n')
      .slice(1)
      .filter((l) => l.startsWith('--   '))
      .map((l) => l.replace(/^--   /, ''))
      .join('\n');
    expect(block).toMatch(/^BEGIN;/);
    expect(block.trim()).toMatch(/COMMIT;$/);
    await db.exec(block);
    const cols = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='wacrm' AND column_name IN ('cancel_reason','reference','pause_reason','encerramento_motivo','slot_size','slot_interval_minutes')`,
    );
    expect(cols.rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wacrm' AND p.proname='remove_campaign_recipients'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '357_campaign_api_control'`)).rows).toHaveLength(0);
    await db.exec(read('357_campaign_api_control.sql'));
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '357_campaign_api_control'`)).rows).toHaveLength(1);
  });
});
