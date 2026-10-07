// Migration 191: wacrm.dispatch_errors_summary — resumo por código, por conta, com teto.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;
const ACC = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000b2';
const C1 = '00000000-0000-0000-0000-0000000000c1';
const C2 = '00000000-0000-0000-0000-0000000000c2';
const CX = '00000000-0000-0000-0000-0000000000c9'; // campanha de outra conta
const S1 = '00000000-0000-0000-0000-0000000000d1';
const S2 = '00000000-0000-0000-0000-0000000000d2';

type Summary = { codes: Array<{ erro_codigo: number | null; n: number }>; total: number; truncated: boolean };
const call = async (args: string): Promise<Summary> =>
  (await db.query<{ r: Summary }>(`SELECT wacrm.dispatch_errors_summary(${args}) AS r`)).rows[0].r;

let seq = 0;
const add = (campaign: string, session: string, code: number | null, status = 'erro', at = '2026-10-06T12:00:00Z') => {
  seq += 1;
  const id = `00000000-0000-0000-0000-${String(100000 + seq).padStart(12, '0')}`;
  return db.query(
    'INSERT INTO wacrm.disp_message_queue(id, campaign_id, session_id, status, erro_codigo, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, campaign, session, status, code, at],
  );
};

describe('migration 191 — dispatch_errors_summary', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY, campaign_id uuid, session_id uuid, contact_id uuid, status text,
        erro_codigo integer, updated_at timestamptz DEFAULT now()
      );
      INSERT INTO wacrm.campaigns VALUES ('${C1}','${ACC}'), ('${C2}','${ACC}'), ('${CX}','${OTHER}');
    `);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/191_dispatch_errors_summary.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE wacrm.disp_message_queue');
  });

  it('agrupa por código só os itens em erro da conta (nada de outra conta nem de outros status)', async () => {
    await add(C1, S1, 131026);
    await add(C1, S1, 131026);
    await add(C2, S2, 131049);
    await add(C1, S1, null);
    await add(C1, S1, 131026, 'enviado');
    await add(CX, S1, 131026); // outra conta
    const r = await call(`'${ACC}'`);
    expect(r.total).toBe(4);
    expect(r.truncated).toBe(false);
    const byCode = Object.fromEntries(r.codes.map((c) => [String(c.erro_codigo), c.n]));
    expect(byCode).toEqual({ '131026': 2, '131049': 1, null: 1 });
    // O mesmo pedido para a outra conta só enxerga a própria campanha.
    expect((await call(`'${OTHER}'`)).total).toBe(1);
  });

  it('filtros: período, campanha, número e contatos', async () => {
    await add(C1, S1, 131026, 'erro', '2026-10-01T00:00:00Z');
    await add(C1, S1, 131049, 'erro', '2026-10-06T12:00:00Z');
    await add(C2, S2, 131049, 'erro', '2026-10-06T12:00:00Z');
    expect((await call(`'${ACC}', '2026-10-05T00:00:00Z'`)).total).toBe(2);
    expect((await call(`'${ACC}', NULL, '${C2}'`)).total).toBe(1);
    expect((await call(`'${ACC}', NULL, NULL, '${S1}'`)).total).toBe(2);
    expect((await call(`'${ACC}', NULL, NULL, NULL, ARRAY[]::uuid[]`)).total).toBe(0);
  });

  it('teto: lê no máximo cap + 1 e marca truncated', async () => {
    for (let i = 0; i < 7; i++) await add(C1, S1, 131026, 'erro', `2026-10-06T12:00:0${i}Z`);
    const r = await call(`'${ACC}', NULL, NULL, NULL, NULL, 5`);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
    const exact = await call(`'${ACC}', NULL, NULL, NULL, NULL, 7`);
    expect(exact).toMatchObject({ total: 7, truncated: false });
  });

  it('só o service_role executa', async () => {
    const r = await db.query<{ anon: boolean; svc: boolean }>(
      `SELECT has_function_privilege('anon', 'wacrm.dispatch_errors_summary(uuid, timestamptz, uuid, uuid, uuid[], integer)', 'EXECUTE') AS anon,
              has_function_privilege('service_role', 'wacrm.dispatch_errors_summary(uuid, timestamptz, uuid, uuid, uuid[], integer)', 'EXECUTE') AS svc`,
    );
    expect(r.rows[0]).toEqual({ anon: false, svc: true });
  });
});
