// Migration 325 (RLS fase 2, lote L3): auditoria, tool-calls, versões de prompt, convites e respostas rápidas pelo catálogo.
// "Antes" = policies das migrations originais (131, 141, 148, 017, 301); "depois" = a 325. Nos 6 papéis de sistema o que cada um lê é IDÊNTICO;
// só o papel PERSONALIZADO passa a ser decidido pela permissão (e não pelo compat_role).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, T1, T2, U, asUser, createRolesDb, headerRollback, id, migration } from "./rls-fixture";

const TABLES = ["audit_logs", "intelligence_tool_calls", "ai_prompt_versions", "account_invitations", "quick_replies"] as const;
const QR = { qa: id(701), qpAgent: id(702), qpAdmin: id(703), qt1: id(704), qt2: id(705), qb: id(706) };

describe("migration 325 — auditoria, convites, prompts e respostas rápidas por permissão", { timeout: 180_000 }, () => {
  let db: PGlite;
  const before: Record<string, Record<string, string[]>> = {};
  const after: Record<string, Record<string, string[]>> = {};
  const everyone = () => [...SYSTEM, "other", "soAuditoria", "adminSemNada", "gestorRespostas"];

  const read = async (who: string) => {
    const out: Record<string, string[]> = {};
    for (const t of TABLES) out[t] = (await asUser<{ id: string }>(db, who, `SELECT id::text FROM wacrm.${t}`)).map((r) => r.id).sort();
    return out;
  };

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "soAuditoria", compat: "admin", permissions: ["audit.view"] },
      { who: "adminSemNada", compat: "admin", permissions: ["members.view", "members.manage"] },
      { who: "gestorRespostas", compat: "admin", permissions: ["inbox.view", "inbox.quick_replies.manage"] },
    ]);
    await db.exec(`
      CREATE TABLE wacrm.audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
      CREATE TABLE wacrm.intelligence_tool_calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
      CREATE TABLE wacrm.ai_prompt_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
      CREATE TABLE wacrm.account_invitations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, email text);
      CREATE TABLE wacrm.quick_replies (id uuid PRIMARY KEY, account_id uuid NOT NULL, visibility text NOT NULL, created_by uuid, team_id uuid);
      GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.audit_logs, wacrm.intelligence_tool_calls, wacrm.ai_prompt_versions, wacrm.account_invitations, wacrm.quick_replies TO authenticated;
      ALTER TABLE wacrm.audit_logs ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.intelligence_tool_calls ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.ai_prompt_versions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.account_invitations ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.quick_replies ENABLE ROW LEVEL SECURITY;

      -- ANTES (131, 141, 148, 017, 301)
      CREATE POLICY audit_logs_select ON wacrm.audit_logs FOR SELECT USING (wacrm.is_account_member(account_id) AND EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = audit_logs.account_id AND p.account_role IN ('owner', 'admin')));
      CREATE POLICY intelligence_tool_calls_select ON wacrm.intelligence_tool_calls FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id) AND EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = intelligence_tool_calls.account_id AND p.account_role IN ('owner', 'admin')));
      CREATE POLICY ai_prompt_versions_select ON wacrm.ai_prompt_versions FOR SELECT USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY account_invitations_select ON wacrm.account_invitations FOR SELECT USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY account_invitations_modify ON wacrm.account_invitations FOR ALL USING (wacrm.is_account_member(account_id, 'admin')) WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY quick_replies_select ON wacrm.quick_replies FOR SELECT USING (wacrm.is_account_member(account_id) AND (visibility = 'account' OR (visibility = 'personal' AND created_by = auth.uid()) OR (visibility = 'team' AND (wacrm.is_account_member(account_id, 'admin') OR team_id IN (SELECT tm.team_id FROM wacrm.team_members tm WHERE tm.user_id = auth.uid())))));

      INSERT INTO wacrm.audit_logs (account_id) VALUES ('${ACC}'), ('${ACC}'), ('${ACC_B}');
      INSERT INTO wacrm.intelligence_tool_calls (account_id) VALUES ('${ACC}'), ('${ACC_B}');
      INSERT INTO wacrm.ai_prompt_versions (account_id) VALUES ('${ACC}'), ('${ACC}'), ('${ACC_B}');
      INSERT INTO wacrm.account_invitations (account_id, email) VALUES ('${ACC}', 'a@x.com'), ('${ACC_B}', 'b@x.com');
      INSERT INTO wacrm.quick_replies VALUES
        ('${QR.qa}', '${ACC}', 'account', '${U.admin}', NULL), ('${QR.qpAgent}', '${ACC}', 'personal', '${U.agent}', NULL), ('${QR.qpAdmin}', '${ACC}', 'personal', '${U.admin}', NULL),
        ('${QR.qt1}', '${ACC}', 'team', '${U.admin}', '${T1}'), ('${QR.qt2}', '${ACC}', 'team', '${U.admin}', '${T2}'), ('${QR.qb}', '${ACC_B}', 'account', '${U.other}', NULL);
    `);
    for (const who of everyone()) before[who] = await read(who);

    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await expect(db.exec(migration("325_audit_admin_tables_rls_has_perm.sql"))).rejects.toThrow(/sem role_id/);
    await db.exec("ROLLBACK");
    expect(await read("admin")).toEqual(before.admin); // abortou sem alterar nada
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL) WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);

    await db.exec(migration("325_audit_admin_tables_rls_has_perm.sql"));
    for (const who of everyone()) after[who] = await read(who);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("a regra de hoje, para conferir o cenário: só owner/admin leem auditoria, tool-calls, prompts e convites; respostas rápidas por visibilidade", () => {
    for (const w of ["owner", "admin"]) {
      expect(before[w].audit_logs).toHaveLength(2);
      expect(before[w].account_invitations).toHaveLength(1);
    }
    expect(before.owner.quick_replies).toHaveLength(3); // conta + as 2 de equipe (admin+ vê as de equipe; não é autor de nenhuma pessoal)
    expect(before.admin.quick_replies).toHaveLength(4); // + a pessoal dele
    for (const w of ["supervisor", "agent", "viewer", "agent2"]) for (const t of ["audit_logs", "intelligence_tool_calls", "ai_prompt_versions", "account_invitations"]) expect(before[w][t], `${w}:${t}`).toEqual([]);
  });

  it("EQUIVALÊNCIA: nos 6 papéis de sistema e na outra conta, o que cada um lê nas 5 tabelas é IDÊNTICO antes e depois", () => {
    for (const who of [...SYSTEM, "other"]) expect(after[who], who).toEqual(before[who]);
  });

  it("respostas rápidas por visibilidade nos papéis de sistema (conferência): admin vê as 2 de equipe; supervisor/operador só a da equipe deles; viewer só as da conta e as dele", () => {
    expect(after.admin.quick_replies.sort()).toEqual([QR.qa, QR.qpAdmin, QR.qt1, QR.qt2].sort());
    expect(after.supervisor.quick_replies.sort()).toEqual([QR.qa, QR.qt1].sort());
    expect(after.agent.quick_replies.sort()).toEqual([QR.qa, QR.qpAgent, QR.qt1].sort());
    expect(after.agent2.quick_replies.sort()).toEqual([QR.qa, QR.qt2].sort());
    expect(after.viewer.quick_replies).toEqual([QR.qa]);
  });

  it("papel PERSONALIZADO decidido pela permissão: admin-compat só com audit.view lê auditoria e MAIS NADA; admin-compat sem as chaves não lê nada administrativo", () => {
    expect(before.soAuditoria.account_invitations).toHaveLength(1); // antes: compat admin lia tudo
    expect(after.soAuditoria.audit_logs).toHaveLength(2);
    for (const t of ["intelligence_tool_calls", "ai_prompt_versions", "account_invitations"]) expect(after.soAuditoria[t], t).toEqual([]);
    for (const t of ["audit_logs", "intelligence_tool_calls", "ai_prompt_versions", "account_invitations"]) expect(after.adminSemNada[t], t).toEqual([]);
    // respostas rápidas de equipe: só quem tem inbox.quick_replies.manage vê todas; sem a chave, só as que são dele
    expect(after.gestorRespostas.quick_replies.sort()).toEqual([QR.qa, QR.qt1, QR.qt2].sort());
    expect(after.adminSemNada.quick_replies).toEqual([QR.qa]);
  });

  it("convites: a escrita continua admin+ (mesma condição de antes) e a leitura vem só da policy por permissão (a antiga FOR ALL não existe mais)", async () => {
    const cmds = (await db.query<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = 'account_invitations' ORDER BY 1`)).rows;
    expect(cmds.map((c) => `${c.policyname}:${c.cmd}`)).toEqual(["account_invitations_delete:DELETE", "account_invitations_insert:INSERT", "account_invitations_select:SELECT", "account_invitations_update:UPDATE"]);
    await expect(asUser(db, "admin", `INSERT INTO wacrm.account_invitations (account_id, email) VALUES ('${ACC}', 'novo@x.com')`)).resolves.toBeDefined();
    await expect(asUser(db, "agent", `INSERT INTO wacrm.account_invitations (account_id, email) VALUES ('${ACC}', 'x@x.com')`)).rejects.toThrow(/row-level security/i);
    expect((await asUser(db, "admin", `DELETE FROM wacrm.account_invitations WHERE email = 'novo@x.com' RETURNING id`)).length).toBe(1);
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve EXATAMENTE a regra de antes (todos os usuários, 5 tabelas) e remove o registro; reaplicar funciona", async () => {
    await db.exec(headerRollback("325_audit_admin_tables_rls_has_perm.sql"));
    for (const who of everyone()) expect(await read(who), `${who} depois do rollback`).toEqual(before[who]);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '325%'`)).rows).toEqual([]);
    await db.exec(migration("325_audit_admin_tables_rls_has_perm.sql"));
    for (const who of everyone()) expect(await read(who), `${who} reaplicada`).toEqual(after[who]);
  });
});
