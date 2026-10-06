import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const campaign = '00000000-0000-0000-0000-000000000011';
const otherCampaign = '00000000-0000-0000-0000-000000000012';
const id = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
let db: PGlite;

describe('migration 163 — reflow_campaign_queue', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, status text);
      CREATE TABLE wacrm.disp_message_queue (
        id uuid PRIMARY KEY, campaign_id uuid REFERENCES wacrm.campaigns, status text, scheduled_at timestamptz
      );
      INSERT INTO wacrm.campaigns VALUES ('${campaign}', 'em_execucao'), ('${otherCampaign}', 'em_execucao');
      INSERT INTO wacrm.disp_message_queue VALUES
        ('${id(1)}', '${campaign}', 'agendado', '2026-10-17 13:00Z'),
        ('${id(2)}', '${campaign}', 'enviando', '2026-10-17 13:00Z'),
        ('${id(3)}', '${campaign}', 'pausado', '2026-10-17 13:00Z'),
        ('${id(4)}', '${otherCampaign}', 'agendado', '2026-10-17 13:00Z');
    `);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/163_reflow_campaign_queue.sql'), 'utf8');
    await db.exec(sql.replace(/NOTIFY pgrst[^;]*;/g, ''));
    // Idempotente: aplicar de novo não falha.
    await db.exec(sql.replace(/NOTIFY pgrst[^;]*;/g, ''));
  });
  afterAll(async () => {
    await db.close();
  });

  it("só altera itens 'agendado' da própria campanha", async () => {
    const target = '2026-10-19 11:00:00+00';
    const items = [1, 2, 3, 4].map((n) => ({ id: id(n), scheduled_at: target }));
    const res = await db.query<{ n: number }>('SELECT wacrm.reflow_campaign_queue($1::uuid, $2::jsonb) AS n', [
      campaign,
      JSON.stringify(items),
    ]);
    expect(res.rows[0].n).toBe(1);
    const rows = await db.query<{ id: string; moved: boolean }>(
      `SELECT id, scheduled_at = '${target}'::timestamptz AS moved FROM wacrm.disp_message_queue ORDER BY id`
    );
    expect(rows.rows.map((r) => r.moved)).toEqual([true, false, false, false]);
  });

  it('lista vazia/nula não altera nada', async () => {
    const res = await db.query<{ n: number }>('SELECT wacrm.reflow_campaign_queue($1::uuid, NULL) AS n', [campaign]);
    expect(res.rows[0].n).toBe(0);
  });
});
