// PRD 24, item 7 — sessões e 2FA: migration 290 (PGlite) + helpers de src/lib/auth/sessions.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const U1 = "00000000-0000-0000-0000-0000000000a1";
const U2 = "00000000-0000-0000-0000-0000000000a2";
const S1 = "10000000-0000-4000-8000-000000000001";
const S2 = "10000000-0000-4000-8000-000000000002";
const S3 = "10000000-0000-4000-8000-000000000003";
const SX = "10000000-0000-4000-8000-0000000000ff"; // sessão de OUTRO usuário
const migration = () => readFileSync(resolve(process.cwd(), "supabase/migrations/290_user_sessions_mfa.sql"), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const BASE = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth; GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY, user_id uuid, friendly_name text, factor_type text, status text, secret text, created_at timestamptz);
  CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, session_id uuid, token text);
  INSERT INTO auth.mfa_factors VALUES ('20000000-0000-4000-8000-000000000001', '${U1}', 'Celular', 'totp', 'verified', 'SEGREDO-NAO-VAZAR', '2026-10-01T10:00:00Z'),
    ('20000000-0000-4000-8000-000000000002', '${U1}', 'Tablet', 'totp', 'unverified', 'SEGREDO-2', '2026-10-02T10:00:00Z'),
    ('20000000-0000-4000-8000-000000000003', '${U2}', NULL, 'totp', 'verified', 'S3', '2026-10-03T10:00:00Z');
`;

describe("migration 290 — GoTrue recente (user_agent, ip, refreshed_at)", { timeout: 60_000 }, () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BASE);
    await db.exec(`
      CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid, created_at timestamptz, updated_at timestamptz, refreshed_at timestamptz, user_agent text, ip text, aal text, not_after timestamptz);
      ALTER TABLE auth.refresh_tokens ADD CONSTRAINT rt_fk FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;
      INSERT INTO auth.sessions VALUES
        ('${S1}', '${U1}', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', '2026-10-09T09:00:00Z', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537', '203.0.113.7', 'aal1', NULL),
        ('${S2}', '${U1}', '2026-10-02T10:00:00Z', '2026-10-02T10:00:00Z', '2026-10-08T09:00:00Z', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604', '198.51.100.2', 'aal2', '2026-11-01T00:00:00Z'),
        ('${S3}', '${U1}', '2026-10-03T10:00:00Z', '2026-10-03T10:00:00Z', NULL, NULL, NULL, 'aal1', NULL),
        ('${SX}', '${U2}', '2026-10-03T10:00:00Z', '2026-10-03T10:00:00Z', NULL, 'outro', '192.0.2.9', 'aal1', NULL);
      INSERT INTO auth.refresh_tokens (session_id, token) VALUES ('${S1}', 'a'), ('${S2}', 'b'), ('${SX}', 'c');
    `);
    await db.exec(migration());
  });
  afterAll(async () => {
    await db.close();
  });

  it("user_sessions: só as do usuário, mais recente primeiro (refreshed_at), com user_agent/ip/aal", async () => {
    const rows = (await db.query<{ id: string; user_agent: string | null; ip: string | null; aal: string }>(`SELECT * FROM wacrm.user_sessions('${U1}')`)).rows;
    expect(rows.map((r) => r.id)).toEqual([S1, S2, S3]);
    expect(rows[0]).toMatchObject({ ip: "203.0.113.7", aal: "aal1" });
    expect(rows[1].aal).toBe("aal2");
    expect(rows[2].user_agent).toBeNull();
    expect((await db.query(`SELECT * FROM wacrm.user_sessions('${U2}')`)).rows).toHaveLength(1);
  });

  it("revoke_user_session: encerra a do usuário (refresh tokens caem em cascata) e NUNCA a de outro", async () => {
    expect((await db.query<{ r: boolean }>(`SELECT wacrm.revoke_user_session('${U1}', '${SX}') AS r`)).rows[0].r).toBe(false); // sessão do U2
    expect((await db.query(`SELECT 1 FROM auth.sessions WHERE id = '${SX}'`)).rows).toHaveLength(1);
    expect((await db.query<{ r: boolean }>(`SELECT wacrm.revoke_user_session('${U1}', '${S3}') AS r`)).rows[0].r).toBe(true);
    expect((await db.query<{ r: boolean }>(`SELECT wacrm.revoke_user_session('${U1}', '${S3}') AS r`)).rows[0].r).toBe(false); // já era
    expect((await db.query(`SELECT 1 FROM auth.refresh_tokens WHERE token = 'a'`)).rows).toHaveLength(1);
  });

  it("revoke_other_user_sessions: mantém a atual e só mexe nas do usuário", async () => {
    expect((await db.query<{ n: number }>(`SELECT wacrm.revoke_other_user_sessions('${U1}', '${S1}') AS n`)).rows[0].n).toBe(1); // sobrou só a S2
    expect((await db.query(`SELECT id FROM auth.sessions WHERE user_id = '${U1}'`)).rows).toEqual([{ id: S1 }]);
    expect((await db.query(`SELECT 1 FROM auth.refresh_tokens WHERE token = 'b'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM auth.sessions WHERE id = '${SX}'`)).rows).toHaveLength(1);
  });

  it("user_mfa_factors: sem o segredo; só do usuário", async () => {
    const rows = (await db.query<Record<string, unknown>>(`SELECT * FROM wacrm.user_mfa_factors('${U1}')`)).rows;
    expect(rows.map((r) => r.status)).toEqual(["verified", "unverified"]);
    expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "factor_type", "friendly_name", "id", "status"]);
    expect(JSON.stringify(rows)).not.toContain("SEGREDO");
  });

  it("fechadas para anon/authenticated; registrada; idempotente", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query(`SELECT * FROM wacrm.user_sessions('${U1}')`)).rejects.toThrow(/permission denied/i);
        await expect(db.query(`SELECT wacrm.revoke_user_session('${U1}', '${S1}')`)).rejects.toThrow(/permission denied/i);
        await expect(db.query(`SELECT * FROM wacrm.user_mfa_factors('${U1}')`)).rejects.toThrow(/permission denied/i);
      } finally {
        await db.exec(`RESET ROLE`);
      }
    }
    await db.exec(migration());
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations`)).rows).toEqual([{ version: "290_user_sessions_mfa" }]);
  });
});

describe("migration 290 — GoTrue antigo (sem user_agent/ip/refreshed_at)", { timeout: 60_000 }, () => {
  it("continua funcionando: campos ausentes viram null e a ordem cai em updated_at", async () => {
    const db = new PGlite();
    try {
      await db.exec(BASE);
      await db.exec(`
        CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid, created_at timestamptz, updated_at timestamptz);
        INSERT INTO auth.sessions VALUES ('${S1}', '${U1}', '2026-10-01T10:00:00Z', '2026-10-05T10:00:00Z'), ('${S2}', '${U1}', '2026-10-02T10:00:00Z', '2026-10-09T10:00:00Z');
      `);
      await db.exec(migration());
      const rows = (await db.query<{ id: string; user_agent: string | null; ip: string | null; aal: string | null }>(`SELECT * FROM wacrm.user_sessions('${U1}')`)).rows;
      expect(rows.map((r) => r.id)).toEqual([S2, S1]);
      expect(rows[0]).toMatchObject({ user_agent: null, ip: null, aal: null });
    } finally {
      await db.close();
    }
  });
});

// ---- helpers ---------------------------------------------------------------------------------------------------------------------
vi.mock("@/lib/api/v1/respond", async (orig) => await orig());
const { describeUserAgent, isUuid, listMfaFactors, listSessions, revokeOtherSessions, revokeSession, sessionIdFromAccessToken } = await import("./sessions");

const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

describe("helpers de sessão", () => {
  it("sessionIdFromAccessToken lê o claim session_id; lixo vira null", () => {
    expect(sessionIdFromAccessToken(jwt({ session_id: S1 }))).toBe(S1);
    expect(sessionIdFromAccessToken(jwt({ session_id: "nao-uuid" }))).toBeNull();
    expect(sessionIdFromAccessToken(jwt({}))).toBeNull();
    for (const bad of [null, undefined, "", "abc", "a.b.c", "a.!!.c"]) expect(sessionIdFromAccessToken(bad as never)).toBeNull();
  });

  it("describeUserAgent: navegador + sistema, ou o que der", () => {
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537")).toBe("Chrome em Windows");
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/130 Edg/130")).toBe("Edge em Windows");
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604")).toBe("Safari em iOS");
    expect(describeUserAgent("Mozilla/5.0 (X11; Linux x86_64) Firefox/131")).toBe("Firefox em Linux");
    expect(describeUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/130")).toBe("Chrome em Android");
    expect(describeUserAgent("curl/8")).toBe("Dispositivo desconhecido");
    expect(describeUserAgent(null)).toBe("Dispositivo desconhecido");
    expect(isUuid(S1)).toBe(true);
    expect(isUuid("x")).toBe(false);
  });

  const rpcDb = (data: unknown, error: { code?: string; message?: string } | null = null) => ({ rpc: vi.fn(async () => ({ data, error })) }) as never;

  it("listSessions marca a atual, rotula o dispositivo e devolve só campos da tela", async () => {
    const db = rpcDb([{ id: S1, created_at: "c", updated_at: "u", user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130", ip: "1.1.1.1", aal: "aal1", not_after: null }, { id: S2, created_at: "c", updated_at: "u", user_agent: null, ip: null, aal: null, not_after: null }]);
    const out = await listSessions(db, U1, S2);
    expect(out.map((s) => [s.id, s.current, s.device])).toEqual([[S1, false, "Chrome em Windows"], [S2, true, "Dispositivo desconhecido"]]);
    expect((await listSessions(db, U1, null)).every((s) => s.current === false)).toBe(true);
    expect((db as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith("user_sessions", { p_user: U1 });
  });

  it("revokeSession / revokeOtherSessions passam o usuário da sessão e devolvem o resultado", async () => {
    const a = rpcDb(true);
    expect(await revokeSession(a, U1, S1)).toBe(true);
    expect((a as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith("revoke_user_session", { p_user: U1, p_session: S1 });
    expect(await revokeSession(rpcDb(false), U1, S1)).toBe(false);
    const b = rpcDb(3);
    expect(await revokeOtherSessions(b, U1, S1)).toBe(3);
    expect((b as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith("revoke_other_user_sessions", { p_user: U1, p_keep: S1 });
  });

  it("listMfaFactors: enabled só com fator verificado; migration ausente ⇒ 503", async () => {
    expect(await listMfaFactors(rpcDb([{ id: "f1", factor_type: "totp", friendly_name: "Celular", status: "unverified", created_at: "c" }]), U1)).toEqual({
      enabled: false,
      factors: [{ id: "f1", type: "totp", name: "Celular", status: "unverified", created_at: "c" }],
    });
    expect((await listMfaFactors(rpcDb([{ id: "f1", factor_type: "totp", friendly_name: null, status: "verified", created_at: "c" }]), U1)).enabled).toBe(true);
    expect(await listMfaFactors(rpcDb([]), U1)).toEqual({ enabled: false, factors: [] });
    await expect(listMfaFactors(rpcDb(null, { code: "42883", message: "function does not exist" }), U1)).rejects.toMatchObject({ status: 503, code: "unavailable" });
    await expect(listSessions(rpcDb(null, { code: "XX000", message: "boom" }), U1, null)).rejects.toMatchObject({ message: "boom" });
  });
});
