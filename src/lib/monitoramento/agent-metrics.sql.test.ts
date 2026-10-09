import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/300_monitoring_agent_metrics.sql", "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const U1 = "00000000-0000-0000-0000-000000000001";
const U2 = "00000000-0000-0000-0000-000000000002";
const FROM = "2026-10-01T00:00:00Z";
const TO = "2026-10-08T00:00:00Z";
let db: PGlite;

async function metrics(from = FROM, to = TO) {
  return db.query<{ agent_id: string; first_response_count: string; first_response_avg_seconds: string | null; resolved_count: string }>(
    "SELECT * FROM wacrm.monitoring_agent_metrics($1, $2)", [from, to]);
}

describe("300 — wacrm.monitoring_agent_metrics", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE authenticated; CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, assigned_agent_id uuid,
        created_at timestamptz NOT NULL, first_response_at timestamptz, closed_at timestamptz);
      CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${A}'::uuid $$;
      INSERT INTO wacrm.conversations (account_id, assigned_agent_id, created_at, first_response_at, closed_at) VALUES
        ('${A}', '${U1}', '2026-10-02T10:00:00Z', '2026-10-02T10:01:00Z', '2026-10-02T11:00:00Z'),
        ('${A}', '${U1}', '2026-10-03T10:00:00Z', '2026-10-03T10:03:00Z', NULL),
        ('${A}', '${U2}', '2026-10-03T10:00:00Z', '2026-10-03T10:10:00Z', '2026-10-04T10:00:00Z'),
        ('${A}', NULL,    '2026-10-03T10:00:00Z', '2026-10-03T10:10:00Z', '2026-10-04T10:00:00Z'),
        ('${A}', '${U1}', '2026-09-20T10:00:00Z', '2026-09-20T10:01:00Z', '2026-09-20T11:00:00Z'),
        ('${B}', '${U1}', '2026-10-02T10:00:00Z', '2026-10-02T10:20:00Z', '2026-10-02T11:00:00Z');`);
    await db.exec(migration);
    await db.exec(migration);
  }, 30000);
  afterAll(async () => { await db?.close(); });

  it("agrega por atendente só da conta, do período e sem conversa sem dono", async () => {
    const rows = (await metrics()).rows;
    expect(rows).toHaveLength(2);
    const u1 = rows.find((r) => r.agent_id === U1)!;
    expect(Number(u1.first_response_count)).toBe(2);
    expect(Number(u1.first_response_avg_seconds)).toBe(120);
    expect(Number(u1.resolved_count)).toBe(1);
    const u2 = rows.find((r) => r.agent_id === U2)!;
    expect(Number(u2.first_response_avg_seconds)).toBe(600);
    expect(Number(u2.resolved_count)).toBe(1);
  });

  it("rejeita período inválido ou acima de 92 dias", async () => {
    await expect(metrics(TO, FROM)).rejects.toThrow(/período inválido/);
    await expect(metrics("2026-01-01T00:00:00Z", TO)).rejects.toThrow(/92 dias/);
  });

  it("registra a migration e é idempotente", async () => {
    const r = await db.query("SELECT count(*)::int AS n FROM wacrm.schema_migrations WHERE version = '300_monitoring_agent_metrics'");
    expect((r.rows[0] as { n: number }).n).toBe(1);
  });
});
