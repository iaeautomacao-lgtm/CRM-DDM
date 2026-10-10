// Migration 326 (RLS fase 2, lote L4): equipes, templates, canais auxiliares e conta pelo catálogo (teams.view / templates.view / channels.view / account.view).
// As chaves são de TODOS os papéis de sistema ⇒ o retrato do que cada papel lê é IDÊNTICO antes e depois; só o papel personalizado sem a chave deixa de ler.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, T1, T2, U, asUser, createRolesDb, headerRollback, id, migration } from "./rls-fixture";

const TABLES = ["accounts", "teams", "team_members", "team_allowed_templates", "team_outcome_tags", "message_templates", "disparador_message_templates", "clients", "whatsapp_test_sends"] as const;
const KEY = (t: string) => (t === "accounts" ? "id" : t === "team_members" || t === "team_allowed_templates" || t === "team_outcome_tags" ? "team_id" : "id");

describe("migration 326 — equipes, templates, canais auxiliares e conta por permissão", { timeout: 180_000 }, () => {
  let db: PGlite;
  const before: Record<string, Record<string, string[]>> = {};
  const after: Record<string, Record<string, string[]>> = {};
  const everyone = () => [...SYSTEM, "other", "soEquipes", "semNada"];

  const read = async (who: string) => {
    const out: Record<string, string[]> = {};
    for (const t of TABLES) out[t] = (await asUser<{ k: string }>(db, who, `SELECT ${KEY(t)}::text AS k FROM wacrm.${t}`)).map((r) => r.k).sort();
    return out;
  };

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "soEquipes", compat: "viewer", permissions: ["teams.view"] },
      { who: "semNada", compat: "agent", permissions: ["inbox.view"] },
    ]);
    await db.exec(`
      CREATE TABLE wacrm.team_allowed_templates (team_id uuid, template_id uuid);
      CREATE TABLE wacrm.team_outcome_tags (team_id uuid, tag_id uuid);
      CREATE TABLE wacrm.message_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
      CREATE TABLE wacrm.disparador_message_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
      CREATE TABLE wacrm.clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text);
      CREATE TABLE wacrm.whatsapp_test_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
      GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.team_allowed_templates, wacrm.team_outcome_tags, wacrm.message_templates, wacrm.disparador_message_templates, wacrm.clients, wacrm.whatsapp_test_sends, wacrm.teams, wacrm.team_members, wacrm.accounts TO authenticated;
      ALTER TABLE wacrm.accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.teams ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.team_members ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.team_allowed_templates ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.team_outcome_tags ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.message_templates ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.disparador_message_templates ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.clients ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.whatsapp_test_sends ENABLE ROW LEVEL SECURITY;

      -- ANTES (017, 049, 062, 106, 107, 042, 128, 074)
      CREATE POLICY accounts_select ON wacrm.accounts FOR SELECT USING (wacrm.is_account_member(id));
      CREATE POLICY teams_select ON wacrm.teams FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY team_members_select ON wacrm.team_members FOR SELECT USING (auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_members.team_id WHERE p.account_id = t.account_id));
      CREATE POLICY team_allowed_templates_select ON wacrm.team_allowed_templates FOR SELECT USING (auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_allowed_templates.team_id WHERE p.account_id = t.account_id));
      CREATE POLICY team_outcome_tags_select ON wacrm.team_outcome_tags FOR SELECT USING (auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_outcome_tags.team_id WHERE p.account_id = t.account_id));
      CREATE POLICY message_templates_select ON wacrm.message_templates FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY disparador_message_templates_select ON wacrm.disparador_message_templates FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY clients_select ON wacrm.clients FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id));
      CREATE POLICY clients_write ON wacrm.clients FOR ALL TO authenticated USING (wacrm.is_account_member(account_id, 'admin')) WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY whatsapp_test_sends_select ON wacrm.whatsapp_test_sends FOR SELECT USING (wacrm.is_account_member(account_id));

      INSERT INTO wacrm.team_allowed_templates VALUES ('${T1}', '${id(801)}'), ('${T2}', '${id(802)}');
      INSERT INTO wacrm.team_outcome_tags VALUES ('${T1}', '${id(811)}');
      INSERT INTO wacrm.message_templates (account_id) VALUES ('${ACC}'), ('${ACC}'), ('${ACC_B}');
      INSERT INTO wacrm.disparador_message_templates (account_id) VALUES ('${ACC}'), ('${ACC_B}');
      INSERT INTO wacrm.clients (account_id, name) VALUES ('${ACC}', 'c1'), ('${ACC}', 'c2'), ('${ACC_B}', 'cb');
      INSERT INTO wacrm.whatsapp_test_sends (account_id) VALUES ('${ACC}'), ('${ACC_B}');
    `);
    for (const who of everyone()) before[who] = await read(who);

    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await expect(db.exec(migration("326_teams_templates_channels_rls_has_perm.sql"))).rejects.toThrow(/sem role_id/);
    await db.exec("ROLLBACK");
    expect(await read("admin")).toEqual(before.admin);
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL) WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);

    await db.exec(migration("326_teams_templates_channels_rls_has_perm.sql"));
    for (const who of everyone()) after[who] = await read(who);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("a regra de hoje, para conferir o cenário: qualquer membro lê as 9 tabelas da conta (inclusive o visualizador e o papel personalizado sem as chaves)", () => {
    expect(before.viewer.accounts).toEqual([ACC]);
    expect(before.viewer.clients).toHaveLength(2);
    expect(before.semNada.message_templates).toHaveLength(2);
    expect(before.other.accounts).toEqual([ACC_B]);
  });

  it("EQUIVALÊNCIA: nos 6 papéis de sistema e na outra conta, o que cada um lê nas 9 tabelas é IDÊNTICO antes e depois", () => {
    for (const who of [...SYSTEM, "other"]) expect(after[who], who).toEqual(before[who]);
  });

  it("o app continua abrindo: todo papel de sistema lê a PRÓPRIA organização (accounts) e só ela", () => {
    for (const who of SYSTEM) expect(after[who].accounts, who).toEqual([ACC]);
    expect(after.other.accounts).toEqual([ACC_B]);
  });

  it("papel PERSONALIZADO decidido pela permissão: só teams.view lê só as 4 tabelas de equipe; sem nenhuma chave não lê nada (conta, templates, canais, equipes)", () => {
    expect(after.soEquipes.teams).toEqual(before.soEquipes.teams);
    expect(after.soEquipes.team_members.length).toBeGreaterThan(0);
    for (const t of ["accounts", "message_templates", "disparador_message_templates", "clients", "whatsapp_test_sends"]) expect(after.soEquipes[t], t).toEqual([]);
    for (const t of TABLES) expect(after.semNada[t], t).toEqual([]);
  });

  it("clients: escrita continua admin+ (mesma condição) e a leitura vem só da policy por permissão (a antiga FOR ALL não existe mais)", async () => {
    const cmds = (await db.query<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = 'clients' ORDER BY 1`)).rows;
    expect(cmds.map((c) => `${c.policyname}:${c.cmd}`)).toEqual(["clients_delete:DELETE", "clients_insert:INSERT", "clients_select:SELECT", "clients_update:UPDATE"]);
    await expect(asUser(db, "admin", `INSERT INTO wacrm.clients (account_id, name) VALUES ('${ACC}', 'novo')`)).resolves.toBeDefined();
    await expect(asUser(db, "agent", `INSERT INTO wacrm.clients (account_id, name) VALUES ('${ACC}', 'x')`)).rejects.toThrow(/row-level security/i);
    expect((await asUser(db, "admin", `DELETE FROM wacrm.clients WHERE name = 'novo' RETURNING id`)).length).toBe(1);
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve EXATAMENTE a regra de antes (todos os usuários, 9 tabelas) e remove o registro; reaplicar funciona", async () => {
    await db.exec(headerRollback("326_teams_templates_channels_rls_has_perm.sql"));
    for (const who of everyone()) expect(await read(who), `${who} depois do rollback`).toEqual(before[who]);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '326%'`)).rows).toEqual([]);
    await db.exec(migration("326_teams_templates_channels_rls_has_perm.sql"));
    for (const who of everyone()) expect(await read(who), `${who} reaplicada`).toEqual(after[who]);
  });
});
