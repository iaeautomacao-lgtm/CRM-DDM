// Migration 315: user_sessions (290) passa a ler refreshed_at do GoTrue (timestamp SEM fuso, em UTC) como UTC, qualquer que seja
// o fuso da sessão do banco. PGlite com as migrations REAIS 290 e 315.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const mig = (f: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", f), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const U1 = "00000000-0000-0000-0000-0000000000a1";
const S1 = "10000000-0000-4000-8000-000000000001";
const S2 = "10000000-0000-4000-8000-000000000002";

async function setup(refreshedType: "timestamp" | "timestamptz") {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA wacrm; CREATE SCHEMA auth; GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
    CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
    CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY, user_id uuid, friendly_name text, factor_type text, status text, created_at timestamptz);
    CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid, created_at timestamptz, updated_at timestamptz,
      refreshed_at ${refreshedType}, aal text, not_after timestamptz);
    SET TIME ZONE 'UTC';
    INSERT INTO auth.sessions VALUES
      ('${S1}', '${U1}', '2026-10-01T10:00:00Z', '2026-10-09T13:00:00Z', '2026-10-09 12:00:00', 'aal1', NULL),
      ('${S2}', '${U1}', '2026-10-02T10:00:00Z', '2026-10-09T11:00:00Z', '2026-10-09 14:00:00', 'aal1', '2026-11-01T00:00:00Z');
    SET TIME ZONE 'America/Sao_Paulo';   -- fuso da sessão ≠ UTC: é aqui que a 290 errava
  `);
  await db.exec(mig("290_user_sessions_mfa.sql"));
  return db;
}

type Row = { id: string; updated_at: Date; not_after: Date | null };
const sessions = async (db: PGlite) => (await db.query<Row>(`SELECT * FROM wacrm.user_sessions('${U1}')`)).rows;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

describe("migration 315 — refreshed_at como UTC", { timeout: 60_000 }, () => {
  it("coluna sem fuso (GoTrue atual): a 290 deslocava 3 h; a 315 lê como UTC", async () => {
    const db = await setup("timestamp");
    try {
      // antes: '2026-10-09 14:00:00' lido em São Paulo = 17:00Z (errado)
      expect(iso((await sessions(db))[0].updated_at)).toBe("2026-10-09T17:00:00.000Z");
      await db.exec(mig("315_user_sessions_refreshed_at_utc.sql"));
      await db.exec(mig("315_user_sessions_refreshed_at_utc.sql")); // idempotente
      const rows = await sessions(db);
      expect(rows.map((r) => [r.id, iso(r.updated_at)])).toEqual([
        [S2, "2026-10-09T14:00:00.000Z"],
        [S1, "2026-10-09T12:00:00.000Z"],
      ]);
      expect(iso(rows[0].not_after)).toBe("2026-11-01T00:00:00.000Z");
      expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '315%'`)).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it("coluna com fuso (outra versão do GoTrue): vale o fuso do texto, sem deslocar", async () => {
    const db = await setup("timestamptz");
    try {
      await db.exec(mig("315_user_sessions_refreshed_at_utc.sql"));
      expect((await sessions(db)).map((r) => iso(r.updated_at))).toEqual(["2026-10-09T14:00:00.000Z", "2026-10-09T12:00:00.000Z"]);
    } finally {
      await db.close();
    }
  });

  it("gotrue_ts: com e sem fuso, vazio; fechada para anon/authenticated", async () => {
    const db = await setup("timestamp");
    try {
      await db.exec(mig("315_user_sessions_refreshed_at_utc.sql"));
      const r = (
        await db.query<Record<string, Date | null>>(`SELECT wacrm.gotrue_ts('2026-10-09T12:00:00') a, wacrm.gotrue_ts('2026-10-09T12:00:00.5') b,
          wacrm.gotrue_ts('2026-10-09T09:00:00-03:00') c, wacrm.gotrue_ts('2026-10-09T12:00:00Z') d, wacrm.gotrue_ts('') e, wacrm.gotrue_ts(NULL) f`)
      ).rows[0];
      expect([r.a, r.c, r.d].map(iso)).toEqual(Array(3).fill("2026-10-09T12:00:00.000Z"));
      expect(iso(r.b)).toBe("2026-10-09T12:00:00.500Z");
      expect([r.e, r.f]).toEqual([null, null]);
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await expect(db.query(`SELECT wacrm.gotrue_ts('x')`)).rejects.toThrow(/permission denied/i);
          await expect(db.query(`SELECT * FROM wacrm.user_sessions('${U1}')`)).rejects.toThrow(/permission denied/i);
        } finally {
          await db.exec("RESET ROLE");
        }
      }
    } finally {
      await db.close();
    }
  });

  it("recusa sem a 290", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA wacrm; CREATE SCHEMA auth;
        CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid);`);
      await expect(db.exec(mig("315_user_sessions_refreshed_at_utc.sql"))).rejects.toThrow(/aplique a 290/);
    } finally {
      await db.close();
    }
  });
});
