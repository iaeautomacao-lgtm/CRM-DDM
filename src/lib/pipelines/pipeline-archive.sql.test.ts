// Migration 340 (decisão do dono 13/10, item 7): arquivamento de funil. PGlite com as migrations REAIS 169, 240, 241, 241b,
// 276, 304 e 340. Prova: arquivar esconde negócios e etapas (listas e relatórios leem pelo RLS) sem apagar nada; o funil
// arquivado continua legível para restaurar; só pipelines.manage arquiva/restaura; só o proprietário exclui em definitivo;
// tudo auditado.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const mig = (f: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", f), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "0000000a-0000-0000-0000-000000000000";
const B = "0000000b-0000-0000-0000-000000000000";
const OWNER = "00000000-0000-0000-0000-000000000101";
const ADMIN = "00000000-0000-0000-0000-000000000102";
const AGENT = "00000000-0000-0000-0000-000000000103";
const OWNER_B = "00000000-0000-0000-0000-000000000201";
const P1 = "10000000-0000-0000-0000-000000000001";
const PB = "10000000-0000-0000-0000-0000000000b1";

let db: PGlite;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`SELECT set_config('test.uid', $1, false)`, [user]);
  await db.exec("SET ROLE authenticated");
  try {
    return await fn();
  } finally {
    await db.exec("RESET ROLE");
  }
}
const count = (user: string, table: string) =>
  as(user, async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wacrm.${table}`)).rows[0].n);

describe("migration 340 — arquivamento de funil", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
      CREATE TYPE wacrm.account_role_enum AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'viewer');
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY, name text NOT NULL DEFAULT 'conta', owner_user_id uuid);
      CREATE TABLE wacrm.profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, account_id uuid REFERENCES wacrm.accounts(id),
        account_role wacrm.account_role_enum NOT NULL, full_name text, avatar_url text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
        AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
      CREATE FUNCTION wacrm.is_account_member(p_account uuid, p_role text DEFAULT 'viewer') RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
        AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = p_account) $$;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.audit_test (account_id uuid, action text, resource_id uuid, summary text);
      CREATE FUNCTION wacrm.audit_write(p_account uuid, p_event text, p_resource_type text, p_resource_id uuid, p_label text,
        p_action text, p_summary text, p_changes jsonb DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS void
        LANGUAGE sql SECURITY DEFINER AS $$ INSERT INTO wacrm.audit_test VALUES (p_account, p_action, p_resource_id, p_summary) $$;
      -- funis no formato da 017 (o que importa aqui)
      CREATE TABLE wacrm.pipelines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text NOT NULL);
      CREATE TABLE wacrm.pipeline_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid NOT NULL REFERENCES wacrm.pipelines(id) ON DELETE CASCADE, name text);
      CREATE TABLE wacrm.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
        pipeline_id uuid NOT NULL REFERENCES wacrm.pipelines(id) ON DELETE CASCADE, stage_id uuid REFERENCES wacrm.pipeline_stages(id), title text);
      ALTER TABLE wacrm.pipelines ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.deals ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.pipeline_stages ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, DELETE ON wacrm.pipelines, wacrm.deals, wacrm.pipeline_stages TO authenticated;
      GRANT SELECT ON wacrm.profiles, wacrm.accounts TO authenticated;
      INSERT INTO wacrm.accounts (id) VALUES ('${A}'), ('${B}');
    `);
    await db.exec(mig("169_profiles_lock_privileged_columns.sql"));
    for (const f of ["240_roles_foundation.sql", "241_roles_functions.sql", "241b_profiles_role_id_idx.sql", "276_billing_permissions.sql", "304_view_permission_keys.sql"]) {
      await db.exec(mig(f));
    }
    // policies de leitura da 305 (pipelines) e de exclusão da 017, como em produção antes da 340
    await db.exec(`
      CREATE POLICY pipelines_select ON wacrm.pipelines FOR SELECT USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.view')));
      CREATE POLICY pipelines_delete ON wacrm.pipelines FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY deals_delete ON wacrm.deals FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
    `);
    await db.exec(mig("340_pipeline_archive.sql"));
    await db.exec(mig("340_pipeline_archive.sql")); // idempotente
    await db.exec(`INSERT INTO wacrm.profiles (user_id, account_id, account_role) VALUES
      ('${OWNER}', '${A}', 'owner'), ('${ADMIN}', '${A}', 'admin'), ('${AGENT}', '${A}', 'agent'), ('${OWNER_B}', '${B}', 'owner')`);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`RESET ROLE; DELETE FROM wacrm.pipelines; DELETE FROM wacrm.audit_test;
      INSERT INTO wacrm.pipelines (id, account_id, name) VALUES ('${P1}', '${A}', 'Vendas'), ('${PB}', '${B}', 'Outra');
      INSERT INTO wacrm.pipeline_stages (pipeline_id, name) VALUES ('${P1}', 'Novo'), ('${P1}', 'Ganho');
      INSERT INTO wacrm.deals (account_id, pipeline_id, title) VALUES ('${A}', '${P1}', 'd1'), ('${A}', '${P1}', 'd2');`);
  });

  const archive = (user: string, id = P1) => as(user, async () => (await db.query<{ r: Record<string, unknown> }>(`SELECT wacrm.archive_pipeline($1) AS r`, [id])).rows[0].r);
  const restore = (user: string, id = P1) => as(user, async () => (await db.query<{ r: Record<string, unknown> }>(`SELECT wacrm.restore_pipeline($1) AS r`, [id])).rows[0].r);

  it("arquivar: negócios e etapas somem das leituras (listas e relatórios); o funil continua legível com archived_at; nada é apagado", async () => {
    expect(await count(AGENT, "deals")).toBe(2);
    expect(await archive(ADMIN)).toEqual({ id: P1, archived: true, deals: 2 });
    expect(await count(AGENT, "deals")).toBe(0);
    expect(await count(OWNER, "deals")).toBe(0);
    expect(await count(AGENT, "pipeline_stages")).toBe(0);
    const p = await as(AGENT, async () => (await db.query<{ archived_at: Date | null; archived_by: string }>(`SELECT archived_at, archived_by FROM wacrm.pipelines WHERE id = $1`, [P1])).rows[0]);
    expect(p.archived_at).not.toBeNull();
    expect(p.archived_by).toBe(ADMIN);
    expect((await db.query(`SELECT 1 FROM wacrm.deals`)).rows).toHaveLength(2); // service: tudo ainda lá
  });

  it("restaurar volta tudo", async () => {
    await archive(OWNER);
    expect(await restore(ADMIN)).toEqual({ id: P1, archived: false });
    expect(await count(AGENT, "deals")).toBe(2);
    expect(await count(AGENT, "pipeline_stages")).toBe(2);
  });

  it("só pipelines.manage arquiva/restaura; funil de outra organização = não encontrado", async () => {
    await expect(archive(AGENT)).rejects.toThrow(/não pode arquivar/);
    await expect(restore(AGENT)).rejects.toThrow(/não pode restaurar/);
    await expect(archive(ADMIN, PB)).rejects.toThrow(/não encontrado/);
  });

  it("excluir em definitivo: só o proprietário (o admin não apaga nada); auditado com o nome", async () => {
    const deleted = (user: string) => as(user, async () => (await db.query(`DELETE FROM wacrm.pipelines WHERE id = $1 RETURNING id`, [P1])).rows.length);
    expect(await deleted(ADMIN)).toBe(0);
    expect((await db.query(`SELECT 1 FROM wacrm.pipelines WHERE id = $1`, [P1])).rows).toHaveLength(1);
    expect(await deleted(OWNER)).toBe(1);
    expect((await db.query(`SELECT 1 FROM wacrm.deals`)).rows).toHaveLength(0); // em cascata
    const audit = (await db.query<{ action: string; summary: string }>(`SELECT action, summary FROM wacrm.audit_test WHERE action = 'pipeline.deleted'`)).rows;
    expect(audit).toEqual([{ action: "pipeline.deleted", summary: "Funil Vendas excluído em definitivo" }]);
  });

  it("auditoria de arquivar e restaurar; pipelines.delete só do proprietário no catálogo; registra", async () => {
    await archive(ADMIN);
    await restore(ADMIN);
    expect((await db.query<{ action: string }>(`SELECT action FROM wacrm.audit_test ORDER BY action`)).rows.map((r) => r.action)).toEqual(["pipeline.archived", "pipeline.restored"]);
    const owners = (await db.query<{ key: string }>(`SELECT r.key FROM wacrm.role_permissions rp JOIN wacrm.account_roles r ON r.id = rp.role_id WHERE rp.permission = 'pipelines.delete'`)).rows;
    expect(owners).toEqual([{ key: "owner" }]);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '340_pipeline_archive'`)).rows).toHaveLength(1);
  });
});
