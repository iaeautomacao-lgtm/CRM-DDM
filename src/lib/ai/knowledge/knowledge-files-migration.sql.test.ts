// Migration 214 (TASK1-B): formaliza wacrm.knowledge_base_files (criada em produção sem migration).
// PGlite com as migrations REAIS 240/241/214 sobre um schema mínimo com a tabela "de produção" (colunas que o
// código usa) e as policies da 170 (escrita do navegador por agent+).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const uid = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;
const ROLES = ["owner", "admin", "supervisor", "agent", "viewer"] as const;
const READERS = new Set(["owner", "admin", "supervisor"]); // ai.agents.view

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner','admin','supervisor','agent','viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, owner_user_id uuid);
  CREATE TABLE wacrm.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
    account_id uuid REFERENCES wacrm.accounts(id), account_role wacrm.account_role_enum NOT NULL, full_name text, avatar_url text);
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT account_id FROM wacrm.profiles WHERE user_id = auth.uid() LIMIT 1 $$;
  CREATE FUNCTION wacrm.is_account_member(p_account uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles WHERE user_id = auth.uid() AND account_id = p_account) $$;
  CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_min wacrm.account_role_enum) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = wacrm, public
    AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles WHERE user_id = auth.uid() AND account_id = p_account) $$;
  GRANT SELECT ON wacrm.profiles, wacrm.accounts TO authenticated;
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
`;

// Tabela "de produção" (sem migration) + o que a 170 fez nela.
const LEGACY_TABLE = `
  CREATE TABLE wacrm.knowledge_base_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES wacrm.accounts(id),
    name text NOT NULL,
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE wacrm.knowledge_base_files ENABLE ROW LEVEL SECURITY;
  GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.knowledge_base_files TO authenticated;
  GRANT ALL ON wacrm.knowledge_base_files TO service_role;
  CREATE POLICY knowledge_base_files_select ON wacrm.knowledge_base_files FOR SELECT TO authenticated
    USING (wacrm.is_account_member(account_id));
  CREATE POLICY knowledge_base_files_write ON wacrm.knowledge_base_files FOR ALL TO authenticated
    USING (wacrm.is_account_member(account_id, 'agent')) WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
  INSERT INTO wacrm.knowledge_base_files (account_id, name, content) VALUES
    ('${A}', 'manual.txt', 'Olá, manual da conta A'), ('${B}', 'outro.txt', 'conta B');
`;

describe("migration 214 — knowledge_base_files formalizada, escrita só pelo servidor", { timeout: 60_000 }, () => {
  let db: PGlite;

  const asUser = (n: number) => db.query(`SELECT set_config('test.uid', $1, false)`, [uid(n)]);
  const asAuthenticated = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec("SET ROLE authenticated");
    try {
      return await fn();
    } finally {
      await db.exec("RESET ROLE");
    }
  };

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    await db.exec(migration("240_roles_foundation.sql"));
    await db.exec(migration("241_roles_functions.sql"));
    for (const [i, role] of ROLES.entries()) {
      await db.query(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES ($1, $2, $3::wacrm.account_role_enum)`, [uid(i + 1), A, role]);
    }
    await db.exec(LEGACY_TABLE);
    await db.exec(migration("214_knowledge_base_files.sql"));
    await db.exec(migration("214_knowledge_base_files.sql")); // idempotente
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("linhas antigas seguem intactas, com char_count e content_hash preenchidos", async () => {
    const rows = (
      await db.query<{ name: string; content: string; char_count: number; content_hash: string; size_bytes: number | null }>(
        `SELECT name, content, char_count, content_hash, size_bytes FROM wacrm.knowledge_base_files WHERE account_id = '${A}'`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "manual.txt", content: "Olá, manual da conta A", char_count: 22, size_bytes: null });
    const { createHash } = await import("node:crypto");
    expect(rows[0].content_hash).toBe(createHash("sha256").update("Olá, manual da conta A").digest("hex"));
  });

  it.each(ROLES.map((r, i) => [r, i + 1] as const))("%s: lê só a própria conta e só com ai.agents.view", async (role, n) => {
    await asUser(n);
    const c = await asAuthenticated(
      async () => (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM wacrm.knowledge_base_files`)).rows[0].c,
    );
    expect(c, role).toBe(READERS.has(role) ? 1 : 0);
  });

  it.each(ROLES.map((r, i) => [r, i + 1] as const))("%s: não escreve pelo navegador (só o servidor)", async (_role, n) => {
    await asUser(n);
    await expect(
      asAuthenticated(() => db.query(`INSERT INTO wacrm.knowledge_base_files (account_id, name, content) VALUES ('${A}', 'x.txt', 'x')`)),
    ).rejects.toThrow();
    await expect(asAuthenticated(() => db.query(`DELETE FROM wacrm.knowledge_base_files`))).rejects.toThrow();
    await expect(asAuthenticated(() => db.query(`UPDATE wacrm.knowledge_base_files SET name = 'y'`))).rejects.toThrow();
  });

  it("service_role grava com as colunas novas", async () => {
    await db.exec("SET ROLE service_role");
    try {
      await db.query(
        `INSERT INTO wacrm.knowledge_base_files (account_id, name, content, mime_type, size_bytes, char_count, content_hash, created_by)
         VALUES ($1, 'tabela.csv', 'a;b', 'text/csv', 3, 3, repeat('0', 64), $2)`,
        [A, uid(2)],
      );
    } finally {
      await db.exec("RESET ROLE");
    }
    const c = (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM wacrm.knowledge_base_files WHERE mime_type = 'text/csv'`)).rows[0].c;
    expect(c).toBe(1);
  });

  it("registra a si mesma em schema_migrations", async () => {
    const rows = (await db.query<{ version: string }>(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '214%'`)).rows;
    expect(rows).toEqual([{ version: "214_knowledge_base_files" }]);
  });

  it("o app usa o mesmo critério do banco: ai.agents.view lê, ai.agents.edit envia/remove", async () => {
    const { can } = await import("@/lib/auth/permissions");
    for (const role of ROLES) {
      expect(can({ role }, "ai.agents.view"), role).toBe(READERS.has(role));
      expect(can({ role }, "ai.agents.edit"), role).toBe(role === "owner" || role === "admin");
    }
  });
});

describe("migration 214 — banco sem a tabela e tabela incompatível", { timeout: 60_000 }, () => {
  it("cria a tabela do zero", async () => {
    const db = new PGlite();
    try {
      await db.exec(BOOTSTRAP);
      await db.exec(migration("240_roles_foundation.sql"));
      await db.exec(migration("241_roles_functions.sql"));
      await db.exec(migration("214_knowledge_base_files.sql"));
      const cols = (
        await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'knowledge_base_files' ORDER BY 1`,
        )
      ).rows.map((r) => r.column_name);
      expect(cols).toEqual(
        ["account_id", "char_count", "content", "content_hash", "created_at", "created_by", "id", "mime_type", "name", "size_bytes", "updated_at"],
      );
    } finally {
      await db.close();
    }
  });

  it("aborta sem mudar nada se a tabela existir sem as colunas usadas pelo código", async () => {
    const db = new PGlite();
    try {
      await db.exec(BOOTSTRAP);
      await db.exec(migration("240_roles_foundation.sql"));
      await db.exec(migration("241_roles_functions.sql"));
      await db.exec(`CREATE TABLE wacrm.knowledge_base_files (id uuid PRIMARY KEY, account_id uuid, name text)`);
      await expect(db.exec(migration("214_knowledge_base_files.sql"))).rejects.toThrow(/content, created_at/);
      await db.exec("ROLLBACK").catch(() => undefined);
      const cols = (
        await db.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'knowledge_base_files'`,
        )
      ).rows[0].c;
      expect(cols).toBe(3);
    } finally {
      await db.close();
    }
  });
});
