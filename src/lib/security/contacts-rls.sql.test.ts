// Migration 323 (RLS fase 2, lote L1): contatos pelo catálogo (contacts.view). Equivalência EXATA para os papéis de sistema:
// o retrato do que cada papel lê ANTES (policies das migrations 017/087/128/170) é IGUAL ao de DEPOIS, em todas as 9 tabelas.
// Só muda para papel PERSONALIZADO: sem contacts.view não lê contatos.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, U, asUser, createRolesDb, id, migration } from "./rls-fixture";

const TABLES = ["contacts", "contact_tags", "contact_custom_values", "contact_import_variables", "contact_phones", "contact_notes", "contact_identities", "tags", "custom_fields"] as const;
const ROW = (t: string) => (t === "contacts" || t === "tags" || t === "custom_fields" || t === "contact_notes" || t === "contact_identities" ? "id" : "contact_id");

describe("migration 323 — contatos pelo catálogo", { timeout: 180_000 }, () => {
  let db: PGlite;
  const snap: Record<"before" | "after", Record<string, number>> = { before: {}, after: {} };
  const rowsOf = async (who: string, t: string) => (await asUser<{ k: string }>(db, who, `SELECT ${ROW(t)}::text AS k FROM wacrm.${t}`)).map((r) => r.k).sort();
  const everyone = [...SYSTEM, "other", "semContatos", "comContatos"];

  async function snapshot(label: "before" | "after") {
    for (const who of everyone) for (const t of TABLES) snap[label][`${who}:${t}`] = (await rowsOf(who, t)).length;
    // o conteúdo (não só a contagem) também precisa bater: guarda como JSON
    for (const who of SYSTEM) for (const t of TABLES) snap[label][`${who}:${t}:ids`] = (await rowsOf(who, t)) as unknown as number;
  }

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "semContatos", compat: "agent", permissions: ["inbox.view", "inbox.reply"] },
      { who: "comContatos", compat: "viewer", permissions: ["contacts.view"] },
    ]);
    const c1 = id(501), c2 = id(502), cb = id(503);
    await db.exec(`
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY, account_id uuid NOT NULL, name text, phone text, cpf text);
      CREATE TABLE wacrm.tags (id uuid PRIMARY KEY, account_id uuid NOT NULL, name text);
      CREATE TABLE wacrm.custom_fields (id uuid PRIMARY KEY, account_id uuid NOT NULL, name text);
      CREATE TABLE wacrm.contact_notes (id uuid PRIMARY KEY, account_id uuid NOT NULL, contact_id uuid, note_text text);
      CREATE TABLE wacrm.contact_identities (id uuid PRIMARY KEY, account_id uuid NOT NULL, contact_id uuid);
      CREATE TABLE wacrm.contact_tags (contact_id uuid, tag_id uuid);
      CREATE TABLE wacrm.contact_custom_values (contact_id uuid, field_id uuid, value text);
      CREATE TABLE wacrm.contact_import_variables (contact_id uuid, name text);
      CREATE TABLE wacrm.contact_phones (contact_id uuid, phone text);
      GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.contacts, wacrm.tags, wacrm.custom_fields, wacrm.contact_notes, wacrm.contact_identities, wacrm.contact_tags,
        wacrm.contact_custom_values, wacrm.contact_import_variables, wacrm.contact_phones TO authenticated;
      ALTER TABLE wacrm.contacts ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.tags ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.custom_fields ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.contact_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.contact_identities ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.contact_tags ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.contact_custom_values ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.contact_import_variables ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.contact_phones ENABLE ROW LEVEL SECURITY;

      -- ANTES: as policies das migrations originais (017, 087, 128, 170), com as FOR ALL de contact_tags/contact_custom_values
      CREATE POLICY contacts_select ON wacrm.contacts FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY tags_select ON wacrm.tags FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY custom_fields_select ON wacrm.custom_fields FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY contact_notes_select ON wacrm.contact_notes FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY contact_identities_select ON wacrm.contact_identities FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id));
      CREATE POLICY contact_tags_select ON wacrm.contact_tags FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id)));
      CREATE POLICY contact_tags_modify ON wacrm.contact_tags FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id, 'agent')))
        WITH CHECK (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
      CREATE POLICY contact_custom_values_select ON wacrm.contact_custom_values FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id)));
      CREATE POLICY contact_custom_values_modify ON wacrm.contact_custom_values FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id, 'agent')))
        WITH CHECK (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
      CREATE POLICY contact_import_variables_select ON wacrm.contact_import_variables FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_import_variables.contact_id AND wacrm.is_account_member(c.account_id)));
      CREATE POLICY contact_phones_select ON wacrm.contact_phones FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id)));

      INSERT INTO wacrm.contacts VALUES ('${c1}', '${ACC}', 'Maria', '5521999990001', '11122233344'), ('${c2}', '${ACC}', 'João', '5521999990002', NULL), ('${cb}', '${ACC_B}', 'Outra', '5521999990003', NULL);
      INSERT INTO wacrm.tags VALUES ('${id(601)}', '${ACC}', 't1'), ('${id(602)}', '${ACC_B}', 'tb');
      INSERT INTO wacrm.custom_fields VALUES ('${id(611)}', '${ACC}', 'f1'), ('${id(612)}', '${ACC_B}', 'fb');
      INSERT INTO wacrm.contact_notes VALUES ('${id(621)}', '${ACC}', '${c1}', 'n'), ('${id(622)}', '${ACC_B}', '${cb}', 'nb');
      INSERT INTO wacrm.contact_identities VALUES ('${id(631)}', '${ACC}', '${c1}'), ('${id(632)}', '${ACC_B}', '${cb}');
      INSERT INTO wacrm.contact_tags VALUES ('${c1}', '${id(601)}'), ('${c2}', '${id(601)}'), ('${cb}', '${id(602)}');
      INSERT INTO wacrm.contact_custom_values VALUES ('${c1}', '${id(611)}', 'v'), ('${cb}', '${id(612)}', 'vb');
      INSERT INTO wacrm.contact_import_variables VALUES ('${c1}', 'x'), ('${cb}', 'y');
      INSERT INTO wacrm.contact_phones VALUES ('${c1}', '5521999990001'), ('${c2}', '5521999990002'), ('${cb}', '5521999990003');
    `);
    await snapshot("before");
  }, 120_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("ANTES: todo membro lia contatos — até o visualizador e o papel personalizado sem contacts.view", () => {
    expect(snap.before["viewer:contacts"]).toBe(2);
    expect(snap.before["semContatos:contacts"]).toBe(2);
    expect(snap.before["other:contacts"]).toBe(1); // só a conta dele
  });

  it("aborta sem alterar nada se existir perfil sem role_id (has_perm é fail-closed e essa pessoa perderia os contatos)", async () => {
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await expect(db.exec(migration("323_contacts_rls_has_perm.sql"))).rejects.toThrow(/sem role_id/);
    await db.exec("ROLLBACK");
    // a policy antiga continua valendo (nada mudou)
    expect(await asUser(db, "admin", `SELECT count(*)::int AS n FROM wacrm.contacts`)).toEqual([{ n: 2 }]);
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL) WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await db.exec(migration("323_contacts_rls_has_perm.sql"));
    await snapshot("after");
  });

  it("DEPOIS: os 6 papéis de sistema leem EXATAMENTE o mesmo de antes em todas as 9 tabelas (contagem e conteúdo)", () => {
    for (const who of SYSTEM) {
      for (const t of TABLES) {
        expect(snap.after[`${who}:${t}`], `${who}:${t}`).toBe(snap.before[`${who}:${t}`]);
        expect(snap.after[`${who}:${t}:ids`], `${who}:${t} ids`).toEqual(snap.before[`${who}:${t}:ids`]);
      }
    }
    // e a conta continua sendo o limite: o usuário da outra conta lê só a dele
    for (const t of TABLES) expect(snap.after[`other:${t}`], `other:${t}`).toBe(snap.before[`other:${t}`]);
    expect(snap.after["owner:contacts"]).toBe(2);
    expect(snap.after["owner:contact_phones"]).toBe(2);
  });

  it("papel PERSONALIZADO: sem contacts.view não lê nenhuma tabela de contatos (nem pela policy FOR ALL de contact_tags); com contacts.view lê como antes", () => {
    for (const t of TABLES) {
      expect(snap.after[`semContatos:${t}`], `semContatos:${t}`).toBe(0);
      expect(snap.after[`comContatos:${t}`], `comContatos:${t}`).toBe(snap.before[`comContatos:${t}`]);
    }
  });

  it("escrita não mudou: operador (agent) continua inserindo em contact_tags de contato que vê; visualizador continua sem escrever", async () => {
    await expect(asUser(db, "agent", `INSERT INTO wacrm.contact_tags VALUES ('${id(501)}', '${id(699)}')`)).resolves.toBeDefined();
    await expect(asUser(db, "viewer", `INSERT INTO wacrm.contact_tags VALUES ('${id(501)}', '${id(698)}')`)).rejects.toThrow(/row-level security/i);
  });

  it("idempotente (rodar de novo não duplica policies) e registra a versão", async () => {
    await db.exec(migration("323_contacts_rls_has_perm.sql"));
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'wacrm' AND policyname LIKE '%\\_select' AND tablename = ANY($1)`, [[...TABLES]])).rows[0].n;
    expect(n).toBe(9);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '323%'`)).rows).toEqual([{ version: "323_contacts_rls_has_perm" }]);
  });
});
