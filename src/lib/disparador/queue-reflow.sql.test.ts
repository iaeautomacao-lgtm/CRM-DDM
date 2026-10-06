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
      CREATE TABLE wacrm.campaigns (id uuid PRIMARY KEY, status text, account_id uuid, next_batch_at timestamptz);
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
  }, 60_000);
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

  it("p_status 'pausado' reagenda só pausados; outro status é recusado", async () => {
    const target = '2026-10-20 11:00:00+00';
    const items = [1, 2, 3].map((n) => ({ id: id(n), scheduled_at: target }));
    const res = await db.query<{ n: number }>("SELECT wacrm.reflow_campaign_queue($1::uuid, $2::jsonb, 'pausado') AS n", [
      campaign,
      JSON.stringify(items),
    ]);
    expect(res.rows[0].n).toBe(1);
    await expect(
      db.query("SELECT wacrm.reflow_campaign_queue($1::uuid, '[]'::jsonb, 'enviando')", [campaign])
    ).rejects.toThrow(/status inválido/);
  });

  it('resume_dispatch_campaign_keep_schedule: reativa sem mexer no scheduled_at', async () => {
    await db.exec(`
      ALTER TABLE wacrm.campaigns ADD COLUMN IF NOT EXISTS account_id uuid;
      ALTER TABLE wacrm.campaigns ADD COLUMN IF NOT EXISTS next_batch_at timestamptz;
      UPDATE wacrm.campaigns SET status = 'pausada', account_id = '00000000-0000-0000-0000-000000000001' WHERE id = '${campaign}';
    `);
    const acc = '00000000-0000-0000-0000-000000000001';
    expect(
      (await db.query<{ n: number | null }>('SELECT wacrm.resume_dispatch_campaign_keep_schedule($1::uuid, $2::uuid) AS n', [campaign, otherCampaign])).rows[0].n
    ).toBeNull();
    const res = await db.query<{ n: number }>('SELECT wacrm.resume_dispatch_campaign_keep_schedule($1::uuid, $2::uuid) AS n', [
      campaign,
      acc,
    ]);
    expect(res.rows[0].n).toBe(1);
    const row = await db.query<{ status: string; kept: boolean }>(
      `SELECT status, scheduled_at = '2026-10-20 11:00:00+00'::timestamptz AS kept FROM wacrm.disp_message_queue WHERE id = '${id(3)}'`
    );
    expect(row.rows[0]).toEqual({ status: 'agendado', kept: true });
    const camp = await db.query<{ status: string }>(`SELECT status FROM wacrm.campaigns WHERE id = '${campaign}'`);
    expect(camp.rows[0].status).toBe('em_execucao');
    // Já em execução: NULL (não reabre).
    expect(
      (await db.query<{ n: number | null }>('SELECT wacrm.resume_dispatch_campaign_keep_schedule($1::uuid, $2::uuid) AS n', [campaign, acc])).rows[0].n
    ).toBeNull();
  });

  it('lista vazia/nula não altera nada', async () => {
    const res = await db.query<{ n: number }>('SELECT wacrm.reflow_campaign_queue($1::uuid, NULL) AS n', [campaign]);
    expect(res.rows[0].n).toBe(0);
  });
});
