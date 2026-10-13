// Migration 336 (RLS fase 3, escrita): contatos e filhas por permissão (contacts.edit / tags.manage).
// Papéis de sistema: o que cada um ESCREVE é idêntico antes e depois (as telas continuam). Papel personalizado passa a valer pelo catálogo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, U, createRolesDb, headerRollback, id, migration } from "./rls-fixture";
import { writeSnapshot, type WriteProbe, type WriteSnap } from "./rls-write-fixture";

const C1 = id(501);
const T1 = id(511);
const F1 = id(521);
const N1 = id(531);
const P1 = id(541);

const PROBES: WriteProbe[] = [
  { table: "contacts", insert: `INSERT INTO wacrm.contacts (account_id, name) VALUES ('${ACC}', 'novo')`, update: `UPDATE wacrm.contacts SET name = 'x' WHERE id = '${C1}' RETURNING 1`, delete: `DELETE FROM wacrm.contacts WHERE id = '${C1}' RETURNING 1` },
  { table: "contact_notes", insert: `INSERT INTO wacrm.contact_notes (account_id, contact_id) VALUES ('${ACC}', '${C1}')`, update: `UPDATE wacrm.contact_notes SET body = 'x' WHERE id = '${N1}' RETURNING 1`, delete: `DELETE FROM wacrm.contact_notes WHERE id = '${N1}' RETURNING 1` },
  { table: "contact_phones", insert: `INSERT INTO wacrm.contact_phones (contact_id) VALUES ('${C1}')`, update: `UPDATE wacrm.contact_phones SET phone = 'x' WHERE id = '${P1}' RETURNING 1`, delete: `DELETE FROM wacrm.contact_phones WHERE id = '${P1}' RETURNING 1` },
  { table: "contact_tags", insert: `INSERT INTO wacrm.contact_tags (contact_id, tag_id) VALUES ('${C1}', '${id(512)}')`, update: `UPDATE wacrm.contact_tags SET tag_id = '${id(513)}' WHERE contact_id = '${C1}' RETURNING 1`, delete: `DELETE FROM wacrm.contact_tags WHERE contact_id = '${C1}' RETURNING 1` },
  { table: "contact_custom_values", insert: `INSERT INTO wacrm.contact_custom_values (contact_id, field_id) VALUES ('${C1}', '${id(522)}')`, update: `UPDATE wacrm.contact_custom_values SET value = 'x' WHERE contact_id = '${C1}' RETURNING 1`, delete: `DELETE FROM wacrm.contact_custom_values WHERE contact_id = '${C1}' RETURNING 1` },
  { table: "custom_fields", insert: `INSERT INTO wacrm.custom_fields (account_id, name) VALUES ('${ACC}', 'novo')`, update: `UPDATE wacrm.custom_fields SET name = 'x' WHERE id = '${F1}' RETURNING 1`, delete: `DELETE FROM wacrm.custom_fields WHERE id = '${F1}' RETURNING 1` },
  { table: "tags", insert: `INSERT INTO wacrm.tags (account_id, name) VALUES ('${ACC}', 'novo')`, update: `UPDATE wacrm.tags SET name = 'x' WHERE id = '${T1}' RETURNING 1`, delete: `DELETE FROM wacrm.tags WHERE id = '${T1}' RETURNING 1` },
];
const CONTACT_TABLES = ["contacts", "contact_notes", "contact_phones", "contact_tags", "contact_custom_values"];
const ADMIN_TABLES = ["custom_fields", "tags"];

const only = (snap: WriteSnap, tables: string[]) => Object.entries(snap).filter(([k]) => tables.includes(k.split(".")[0]));

describe("migration 336 — escrita de contatos e filhas por permissão", { timeout: 240_000 }, () => {
  let db: PGlite;
  const before: Record<string, WriteSnap> = {};
  const after: Record<string, WriteSnap> = {};
  const everyone = () => [...SYSTEM, "other", "soEdit", "soTags", "soView"];

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "soEdit", compat: "viewer", permissions: ["contacts.view", "contacts.edit"] },
      { who: "soTags", compat: "viewer", permissions: ["tags.manage"] },
      { who: "soView", compat: "agent", permissions: ["contacts.view"] },
    ]);
    await db.exec(`
      CREATE TABLE wacrm.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text);
      CREATE TABLE wacrm.contact_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, contact_id uuid, body text);
      CREATE TABLE wacrm.contact_phones (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, phone text);
      CREATE TABLE wacrm.contact_tags (contact_id uuid, tag_id uuid);
      CREATE TABLE wacrm.contact_custom_values (contact_id uuid, field_id uuid, value text);
      CREATE TABLE wacrm.custom_fields (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text);
      CREATE TABLE wacrm.tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text);
      GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.contacts, wacrm.contact_notes, wacrm.contact_phones, wacrm.contact_tags, wacrm.contact_custom_values, wacrm.custom_fields, wacrm.tags TO authenticated;
      ALTER TABLE wacrm.contacts ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.contact_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.contact_phones ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.contact_tags ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.contact_custom_values ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.custom_fields ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.tags ENABLE ROW LEVEL SECURITY;

      -- ANTES: leitura (já por permissão, 323) + escrita por papel (017 / 087)
      CREATE POLICY contacts_select ON wacrm.contacts FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY contacts_insert ON wacrm.contacts FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY contacts_update ON wacrm.contacts FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY contacts_delete ON wacrm.contacts FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY contact_notes_select ON wacrm.contact_notes FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY contact_notes_insert ON wacrm.contact_notes FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY contact_notes_update ON wacrm.contact_notes FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY contact_notes_delete ON wacrm.contact_notes FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY contact_phones_select ON wacrm.contact_phones FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id)));
      CREATE POLICY contact_phones_insert ON wacrm.contact_phones FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
      CREATE POLICY contact_phones_update ON wacrm.contact_phones FOR UPDATE USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
      CREATE POLICY contact_phones_delete ON wacrm.contact_phones FOR DELETE USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
      CREATE POLICY contact_tags_select ON wacrm.contact_tags FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id)));
      CREATE POLICY contact_tags_modify ON wacrm.contact_tags FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
      CREATE POLICY contact_custom_values_select ON wacrm.contact_custom_values FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id)));
      CREATE POLICY contact_custom_values_modify ON wacrm.contact_custom_values FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
      CREATE POLICY custom_fields_select ON wacrm.custom_fields FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY custom_fields_insert ON wacrm.custom_fields FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY custom_fields_update ON wacrm.custom_fields FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY custom_fields_delete ON wacrm.custom_fields FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY tags_select ON wacrm.tags FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY tags_insert ON wacrm.tags FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY tags_update ON wacrm.tags FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY tags_delete ON wacrm.tags FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));

      INSERT INTO wacrm.contacts (id, account_id, name) VALUES ('${C1}', '${ACC}', 'c1'), ('${id(502)}', '${ACC_B}', 'cb');
      INSERT INTO wacrm.contact_notes (id, account_id, contact_id) VALUES ('${N1}', '${ACC}', '${C1}');
      INSERT INTO wacrm.contact_phones (id, contact_id) VALUES ('${P1}', '${C1}');
      INSERT INTO wacrm.contact_tags VALUES ('${C1}', '${T1}');
      INSERT INTO wacrm.contact_custom_values VALUES ('${C1}', '${F1}', 'v');
      INSERT INTO wacrm.custom_fields (id, account_id, name) VALUES ('${F1}', '${ACC}', 'f1');
      INSERT INTO wacrm.tags (id, account_id, name) VALUES ('${T1}', '${ACC}', 't1');
    `);
    for (const who of everyone()) before[who] = await writeSnapshot(db, who, PROBES);

    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await expect(db.exec(migration("336_contacts_write_rls_has_perm.sql"))).rejects.toThrow(/sem role_id/);
    await db.exec("ROLLBACK");
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL) WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);

    await db.exec(migration("336_contacts_write_rls_has_perm.sql"));
    for (const who of everyone()) after[who] = await writeSnapshot(db, who, PROBES);
  }, 200_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("cenário de hoje: agent+ escreve contatos e filhas; só admin+ escreve tags e campos; visualizador e outra conta não escrevem nada", () => {
    expect(before.agent["contacts.insert"]).toBe("ok");
    expect(before.agent["contact_tags.delete"]).toBe("ok");
    expect(before.agent["tags.insert"]).toBe("negado");
    expect(before.admin["tags.insert"]).toBe("ok");
    expect(before.viewer["contacts.insert"]).toBe("negado");
    expect(before.other["contacts.update"]).toBe("negado");
    expect(before.soView["contacts.insert"]).toBe("ok"); // compat agent: o furo do papel personalizado
  });

  it("EQUIVALÊNCIA: nos 6 papéis de sistema e na outra conta, o que cada um escreve é IDÊNTICO antes e depois (as telas continuam)", () => {
    for (const who of [...SYSTEM, "other"]) expect(after[who], who).toEqual(before[who]);
  });

  it("papel personalizado decidido pelo catálogo: contacts.edit escreve contatos e filhas (não tags/campos); tags.manage só tags/campos; só contacts.view não escreve nada", () => {
    for (const [k, v] of only(after.soEdit, CONTACT_TABLES)) expect(v, `soEdit ${k}`).toBe("ok");
    for (const [k, v] of only(after.soEdit, ADMIN_TABLES)) expect(v, `soEdit ${k}`).toBe("negado");
    for (const [k, v] of only(after.soTags, ADMIN_TABLES)) expect(v, `soTags ${k}`).toBe("ok");
    for (const [k, v] of only(after.soTags, CONTACT_TABLES)) expect(v, `soTags ${k}`).toBe("negado");
    for (const [k, v] of Object.entries(after.soView)) expect(v, `soView ${k}`).toBe("negado");
  });

  it("contact_tags e contact_custom_values não têm mais policy FOR ALL (a leitura vem só das policies *_select por permissão)", async () => {
    const rows = (await db.query<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename IN ('contact_tags', 'contact_custom_values') ORDER BY 1`)).rows;
    expect(rows.filter((r) => r.cmd === "ALL")).toEqual([]);
    expect(rows.map((r) => `${r.policyname}:${r.cmd}`)).toEqual([
      "contact_custom_values_delete:DELETE", "contact_custom_values_insert:INSERT", "contact_custom_values_select:SELECT", "contact_custom_values_update:UPDATE",
      "contact_tags_delete:DELETE", "contact_tags_insert:INSERT", "contact_tags_select:SELECT", "contact_tags_update:UPDATE",
    ]);
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve EXATAMENTE a escrita de antes (todos os usuários); reaplicar funciona", async () => {
    await db.exec(headerRollback("336_contacts_write_rls_has_perm.sql"));
    for (const who of everyone()) expect(await writeSnapshot(db, who, PROBES), `${who} depois do rollback`).toEqual(before[who]);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '336%'`)).rows).toEqual([]);
    await db.exec(migration("336_contacts_write_rls_has_perm.sql"));
    for (const who of everyone()) expect(await writeSnapshot(db, who, PROBES), `${who} reaplicada`).toEqual(after[who]);
  });
});
