// Migration 190: tabelas de limite por qualidade, histórico imutável, backfill de política e auditoria por trigger.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: PGlite;
const ACC = '00000000-0000-0000-0000-0000000000a1';
const S1 = '00000000-0000-0000-0000-0000000000b1';

describe('migration 190 — limite por segundo por qualidade', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
      CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY, account_id uuid, display_phone_number text, phone_number_id text);
      CREATE TABLE wacrm.dispatch_channel_limits (session_id uuid PRIMARY KEY, max_in_flight int);
      CREATE TABLE wacrm.audit_log_probe (account_id uuid, action text);
      CREATE FUNCTION wacrm.audit_write(p_account uuid, p_event text, p_resource_type text, p_resource_id uuid, p_label text, p_action text, p_summary text, p_changes jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS void
        LANGUAGE sql AS $$ INSERT INTO wacrm.audit_log_probe VALUES (p_account, p_action) $$;
      INSERT INTO wacrm.accounts VALUES ('${ACC}');
      INSERT INTO wacrm.whatsapp_config VALUES ('${S1}', '${ACC}', '+55 11 99999-0000', 'pn1');
    `);
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/190_dispatch_rate_by_quality.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '');
    await db.exec(sql);
    await db.exec(sql); // idempotente
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it('backfill cria a política padrão da conta (80/40/8/5, teto 80)', async () => {
    const { rows } = await db.query<Record<string, string>>('SELECT * FROM wacrm.dispatch_rate_policy');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].green_rate)).toBe(80);
    expect(Number(rows[0].yellow_rate)).toBe(40);
    expect(Number(rows[0].red_rate)).toBe(8);
    expect(Number(rows[0].unknown_rate)).toBe(5);
    expect(Number(rows[0].max_rate_per_second)).toBe(80);
  });

  it('manual exige motivo e a mudança é auditada pelo trigger', async () => {
    await db.query(`INSERT INTO wacrm.dispatch_channel_rate (session_id, account_id, auto_rate_per_second) VALUES ($1,$2,80)`, [S1, ACC]);
    await expect(db.query(`UPDATE wacrm.dispatch_channel_rate SET manual_rate_per_second = 10 WHERE session_id = $1`, [S1])).rejects.toThrow();
    await db.query(`UPDATE wacrm.dispatch_channel_rate SET manual_rate_per_second = 10, manual_reason = 'teste de carga' WHERE session_id = $1`, [S1]);
    const audited = await db.query('SELECT count(*)::int AS n FROM wacrm.audit_log_probe');
    expect((audited.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it('histórico é imutável: sem delete, só o reconhecimento, uma vez', async () => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO wacrm.dispatch_channel_rate_history (account_id, session_id, source, quality_new) VALUES ($1,$2,'poll','RED') RETURNING id`,
      [ACC, S1],
    );
    const id = ins.rows[0].id;
    await expect(db.query('DELETE FROM wacrm.dispatch_channel_rate_history WHERE id = $1', [id])).rejects.toThrow(/imut/);
    await expect(db.query(`UPDATE wacrm.dispatch_channel_rate_history SET quality_new = 'GREEN' WHERE id = $1`, [id])).rejects.toThrow(/imut/);
    await db.query(`UPDATE wacrm.dispatch_channel_rate_history SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`, [id, ACC]);
    await expect(db.query(`UPDATE wacrm.dispatch_channel_rate_history SET acknowledged_at = now() WHERE id = $1`, [id])).rejects.toThrow(/imut/);
  });

  it('source inválido é recusado', async () => {
    await expect(db.query(`INSERT INTO wacrm.dispatch_channel_rate_history (account_id, session_id, source) VALUES ($1,$2,'x')`, [ACC, S1])).rejects.toThrow();
  });
});
