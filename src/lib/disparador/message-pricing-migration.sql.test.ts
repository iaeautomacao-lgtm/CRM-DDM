// Migration 195: pricing por envio + soma por campanha/número/categoria (PGlite com a 195 real).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: PGlite;
const ACC = 'a0000000-0000-0000-0000-000000000001';
const OTHER = 'a0000000-0000-0000-0000-000000000002';
const C1 = 'c0000000-0000-0000-0000-000000000001';
const C2 = 'c0000000-0000-0000-0000-000000000002';
const N1 = 'b0000000-0000-0000-0000-000000000001';
const N2 = 'b0000000-0000-0000-0000-000000000002';

const ev = (message_id: string, category: string, billable: boolean, account_id = ACC, channel_id = N1) => ({
  message_id, account_id, channel_id, category, pricing_type: 'regular', pricing_model: 'PMP', billable, ts: 1760000000,
});
const record = async (events: unknown[]) =>
  (await db.query<{ n: number }>('SELECT wacrm.record_message_pricing($1::jsonb) AS n', [JSON.stringify(events)])).rows[0].n;
const summary = async (campaign: string | null = null, since: string | null = null) =>
  (await db.query<{ r: Array<{ campaign_id: string; channel_id: string; category: string; billable: boolean; messages: number }> }>(
    'SELECT wacrm.dispatch_cost_summary($1, $2, $3, 500) AS r', [ACC, campaign, since])).rows[0].r;

describe('migration 195', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, account_id uuid);
      CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid, session_id uuid, waha_message_id text);
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      INSERT INTO wacrm.campaigns VALUES ('${C1}', '${ACC}'), ('${C2}', '${ACC}');
    `);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/195_dispatch_message_pricing.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  });
  afterAll(async () => {
    await db.close();
  });

  it('registra a si mesma em schema_migrations', async () => {
    const rows = (await db.query<{ version: string }>("SELECT version FROM wacrm.schema_migrations WHERE version LIKE '195%'")).rows;
    expect(rows).toEqual([{ version: '195_dispatch_message_pricing' }]);
  });

  it('grava em lote, ignora repetido (a Meta reenvia o mesmo pricing em sent/delivered/read) e linhas inválidas', async () => {
    expect(await record([ev('w1', 'marketing', true), ev('w2', 'marketing', true), ev('w3', 'utility', false), ev('w4', 'marketing', true, ACC, N2)])).toBe(4);
    expect(await record([ev('w1', 'utility', false)])).toBe(0); // o 1º pricing vale
    expect((await db.query<{ category: string }>("SELECT category FROM wacrm.dispatch_message_pricing WHERE message_id = 'w1'")).rows[0].category).toBe('marketing');
    expect(await record([{ message_id: '', account_id: ACC }, { message_id: 'x' }])).toBe(0);
    expect(await record([ev('w5', '', true)])).toBe(1);
    expect((await db.query<{ category: string }>("SELECT category FROM wacrm.dispatch_message_pricing WHERE message_id = 'w5'")).rows[0].category).toBe('unknown');
  });

  it('soma por campanha × número × categoria × cobrável, só da conta, só envios que casam com a fila', async () => {
    await db.exec(`INSERT INTO wacrm.disp_message_queue(campaign_id, session_id, waha_message_id) VALUES
      ('${C1}', '${N1}', 'w1'), ('${C1}', '${N1}', 'w2'), ('${C1}', '${N1}', 'w3'), ('${C2}', '${N2}', 'w4'), ('${C2}', '${N2}', 'sem-pricing')`);
    const all = await summary();
    expect(all).toHaveLength(3);
    expect(all).toEqual(expect.arrayContaining([
      { campaign_id: C1, channel_id: N1, category: 'marketing', billable: true, messages: 2 },
      { campaign_id: C1, channel_id: N1, category: 'utility', billable: false, messages: 1 },
      { campaign_id: C2, channel_id: N2, category: 'marketing', billable: true, messages: 1 },
    ]));
    expect(all[0].messages).toBe(2); // maiores primeiro
    expect(await summary(C2)).toEqual([{ campaign_id: C2, channel_id: N2, category: 'marketing', billable: true, messages: 1 }]);
  });

  it('outra conta não vê o custo (pricing e campanha são escopados)', async () => {
    await record([ev('w9', 'marketing', true, OTHER)]);
    await db.exec(`INSERT INTO wacrm.disp_message_queue(campaign_id, session_id, waha_message_id) VALUES ('${C1}', '${N1}', 'w9')`);
    expect((await summary()).reduce((a, r) => a + r.messages, 0)).toBe(4); // w9 não entra na soma da conta ACC
    const other = (await db.query<{ r: unknown[] }>('SELECT wacrm.dispatch_cost_summary($1, NULL, NULL, 500) AS r', [OTHER])).rows[0].r;
    expect(other).toEqual([]); // a campanha C1 é da ACC, não da OTHER
  });

  it('corte por data', async () => {
    expect((await summary(null, '2999-01-01T00:00:00Z'))).toEqual([]);
    expect((await summary(null, '2000-01-01T00:00:00Z')).length).toBeGreaterThan(0);
  });

  it('fechada: só service_role executa e acessa a tabela', async () => {
    const g = await db.query<{ r: string; f: boolean; t: boolean }>(`
      SELECT r,
             has_function_privilege(r, 'wacrm.record_message_pricing(jsonb)', 'EXECUTE') AS f,
             has_table_privilege(r, 'wacrm.dispatch_message_pricing', 'SELECT') AS t
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r)`);
    expect(Object.fromEntries(g.rows.map((x) => [x.r, [x.f, x.t]]))).toEqual({ anon: [false, false], authenticated: [false, false], service_role: [true, true] });
  });
});
