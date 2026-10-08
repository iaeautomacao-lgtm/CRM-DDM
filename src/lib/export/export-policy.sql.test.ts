// Migration 220 (PRD 14, 14.6 — SG-17): histórico e arquivos de exportação só para admin e proprietário (exports.manage).
// PGlite com as migrations REAIS 240/241/220 sobre um schema mínimo (export_history, storage.objects e a policy ANTIGA da 055).

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
const ALLOWED = new Set(["owner", "admin"]); // decisão do dono: supervisor gera relatório (reports.export) mas não lista/baixa o histórico

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth; CREATE SCHEMA storage;
  GRANT USAGE ON SCHEMA wacrm, auth, storage TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE wacrm.account_role_enum AS ENUM ('owner','admin','supervisor','agent','viewer');
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, owner_user_id uuid);
  CREATE TABLE wacrm.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
    account_id uuid REFERENCES wacrm.accounts(id), account_role wacrm.account_role_enum NOT NULL, full_name text, avatar_url text);
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT account_id FROM wacrm.profiles WHERE user_id = auth.uid() LIMIT 1 $$;
  CREATE FUNCTION wacrm.is_account_member(p_account uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles WHERE user_id = auth.uid() AND account_id = p_account) $$;
  GRANT SELECT ON wacrm.profiles, wacrm.accounts TO authenticated;
  -- tabela da 055 e policies ANTIGAS (qualquer membro)
  CREATE TABLE wacrm.export_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES wacrm.accounts(id),
    user_id uuid, user_name text, export_type text NOT NULL DEFAULT 'conversas', description text NOT NULL DEFAULT 'x', period_from timestamptz,
    period_to timestamptz, file_name text NOT NULL DEFAULT 'f.xlsx', storage_path text NOT NULL, file_size bigint, status text NOT NULL DEFAULT 'completed',
    created_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE wacrm.export_history ENABLE ROW LEVEL SECURITY;
  GRANT SELECT ON wacrm.export_history TO authenticated;
  CREATE POLICY export_history_select ON wacrm.export_history FOR SELECT USING (wacrm.is_account_member(account_id));
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT SELECT ON storage.objects TO authenticated;
  CREATE POLICY "account members read exports" ON storage.objects FOR SELECT USING (bucket_id = 'relatorio-exports'
    AND EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND (storage.foldername(name))[1] = p.account_id::text));
  -- RPC da 055 (corpo antigo: qualquer membro)
  CREATE FUNCTION wacrm.get_export_history(p_account_id uuid, p_search text DEFAULT NULL)
  RETURNS TABLE (id uuid, user_name text, export_type text, description text, period_from timestamptz, period_to timestamptz,
    file_name text, storage_path text, file_size bigint, status text, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public, extensions AS $$
    SELECT id, user_name, export_type, description, period_from, period_to, file_name, storage_path, file_size, status, created_at
      FROM wacrm.export_history WHERE account_id = p_account_id AND is_account_member(p_account_id) ORDER BY created_at DESC LIMIT 200 $$;
  GRANT EXECUTE ON FUNCTION wacrm.get_export_history(uuid, text) TO authenticated;
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
`;

describe("migration 220 — exportações só para admin e proprietário", { timeout: 60_000 }, () => {
  let db: PGlite;

  const asUser = (n: number) => db.query(`SELECT set_config('test.uid', $1, false)`, [uid(n)]);
  const count = async (sql: string) => {
    await db.exec("SET ROLE authenticated");
    try {
      return (await db.query<{ c: number }>(sql)).rows[0].c;
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
    await db.exec(`
      INSERT INTO wacrm.export_history (account_id, storage_path, description) VALUES
        ('${A}', '${A}/e1.xlsx', 'Conversas A'), ('${B}', '${B}/e2.xlsx', 'Conversas B');
      INSERT INTO storage.objects (bucket_id, name) VALUES
        ('relatorio-exports', '${A}/e1.xlsx'), ('relatorio-exports', '${B}/e2.xlsx'), ('chat-media', '${A}/foto.jpg');
    `);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("ANTES da 220 (a falha): qualquer membro, até o visualizador, lê o histórico e o arquivo", async () => {
    await asUser(5); // viewer
    expect(await count(`SELECT count(*)::int AS c FROM wacrm.export_history`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS c FROM storage.objects WHERE bucket_id = 'relatorio-exports'`)).toBe(1);
  });

  it("aplica a 220", async () => {
    await db.exec(migration("220_export_history_policy.sql"));
  });

  it.each(ROLES.map((r, i) => [r, i + 1] as const))("%s: export_history, Storage e get_export_history só para admin e proprietário", async (role, n) => {
    await asUser(n);
    const allowed = ALLOWED.has(role);
    expect(await count(`SELECT count(*)::int AS c FROM wacrm.export_history`), `${role} export_history`).toBe(allowed ? 1 : 0);
    expect(await count(`SELECT count(*)::int AS c FROM storage.objects WHERE bucket_id = 'relatorio-exports'`), `${role} storage`).toBe(allowed ? 1 : 0);
    expect(await count(`SELECT count(*)::int AS c FROM wacrm.get_export_history('${A}')`), `${role} rpc`).toBe(allowed ? 1 : 0);
  });

  it("admin continua vendo SÓ a própria conta e só a pasta dela; outros buckets não são afetados pela regra de exportação", async () => {
    await asUser(2); // admin
    expect(await count(`SELECT count(*)::int AS c FROM wacrm.export_history WHERE account_id = '${B}'`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS c FROM wacrm.get_export_history('${B}')`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS c FROM storage.objects WHERE name LIKE '${B}/%'`)).toBe(0);
    // a policy nova é só do bucket de exportações: chat-media não aparece por esta policy (nem sumiu de outras — fora do escopo)
    expect(await count(`SELECT count(*)::int AS c FROM storage.objects WHERE bucket_id = 'chat-media'`)).toBe(0);
  });

  it("get_export_history devolve o storage_path ao admin (o download segue funcionando) e nada ao supervisor nem ao operador", async () => {
    await asUser(2);
    await db.exec("SET ROLE authenticated");
    const ok = await db.query<{ storage_path: string }>(`SELECT storage_path FROM wacrm.get_export_history('${A}')`);
    await asUser(4);
    const none = await db.query(`SELECT storage_path FROM wacrm.get_export_history('${A}')`);
    await asUser(3); // supervisor: gera relatório, mas não lista/baixa o histórico
    const supervisor = await db.query(`SELECT storage_path FROM wacrm.get_export_history('${A}')`);
    await db.exec("RESET ROLE");
    expect(ok.rows).toEqual([{ storage_path: `${A}/e1.xlsx` }]);
    expect(none.rows).toEqual([]);
    expect(supervisor.rows).toEqual([]);
  });

  it("app × banco no mesmo critério: exports.manage = admin/owner; supervisor GERA (reports.export) mas não lista, baixa nem apaga; a tela é admin/owner", async () => {
    const { can } = await import("@/lib/auth/permissions");
    const { canAccessRoute } = await import("@/lib/role-utils");
    for (const role of ROLES) {
      expect(can({ role }, "exports.manage"), `${role} exports.manage`).toBe(ALLOWED.has(role));
      // a tela /relatorios/exportacoes (e o DELETE da API) seguem a MESMA regra do banco
      expect(canAccessRoute(role, "/relatorios/exportacoes"), `${role} página`).toBe(ALLOWED.has(role));
    }
    expect(can({ role: "supervisor" }, "reports.export")).toBe(true); // gerar continua valendo
    expect(can({ role: "agent" }, "reports.export")).toBe(false);
  });

  it("não sobrou a policy antiga; é idempotente", async () => {
    const names = async () =>
      (await db.query<{ policyname: string }>(`SELECT policyname FROM pg_policies WHERE tablename IN ('export_history','objects') ORDER BY 1`)).rows.map((r) => r.policyname);
    const before = await names();
    expect(before).toContain("export managers read exports");
    expect(before).not.toContain("account members read exports");
    await db.exec(migration("220_export_history_policy.sql"));
    expect(await names()).toEqual(before);
  });

  it("pré-check: sem a 241 (has_perm) aborta sem alterar nada", async () => {
    const bare = new PGlite();
    await bare.exec(BOOTSTRAP);
    await expect(bare.exec(migration("220_export_history_policy.sql"))).rejects.toThrow(/has_perm/);
    await bare.exec("ROLLBACK");
    const { rows } = await bare.query<{ policyname: string }>(`SELECT policyname FROM pg_policies WHERE tablename = 'export_history'`);
    expect(rows.map((r) => r.policyname)).toEqual(["export_history_select"]);
    await bare.close();
  });
});
