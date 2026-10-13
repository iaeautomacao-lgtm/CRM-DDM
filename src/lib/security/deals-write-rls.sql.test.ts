// Migration 348 (RLS fase 3, escrita): negócios por contacts.edit; funis e etapas por pipelines.manage. Papéis de sistema escrevem IGUAL antes e depois.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, U, createRolesDb, headerRollback, id, migration } from "./rls-fixture";
import { writeSnapshot, type WriteProbe, type WriteSnap } from "./rls-write-fixture";

const P1 = id(701);
const S1 = id(711);
const D1 = id(721);

const PROBES: WriteProbe[] = [
  { table: "deals", insert: `INSERT INTO wacrm.deals (account_id, pipeline_id, title) VALUES ('${ACC}', '${P1}', 'novo')`, update: `UPDATE wacrm.deals SET title = 'x' WHERE id = '${D1}' RETURNING 1`, delete: `DELETE FROM wacrm.deals WHERE id = '${D1}' RETURNING 1` },
  { table: "pipelines", insert: `INSERT INTO wacrm.pipelines (account_id, name) VALUES ('${ACC}', 'novo')`, update: `UPDATE wacrm.pipelines SET name = 'x' WHERE id = '${P1}' RETURNING 1`, delete: `DELETE FROM wacrm.pipelines WHERE id = '${P1}' RETURNING 1` },
  { table: "pipeline_stages", insert: `INSERT INTO wacrm.pipeline_stages (pipeline_id, name) VALUES ('${P1}', 'nova')`, update: `UPDATE wacrm.pipeline_stages SET name = 'x' WHERE id = '${S1}' RETURNING 1`, delete: `DELETE FROM wacrm.pipeline_stages WHERE id = '${S1}' RETURNING 1` },
];

describe("migration 348 — escrita de negócios e funis por permissão", { timeout: 240_000 }, () => {
  let db: PGlite;
  const before: Record<string, WriteSnap> = {};
  const after: Record<string, WriteSnap> = {};
  const everyone = () => [...SYSTEM, "other", "soDeals", "soFunis", "soView"];

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "soDeals", compat: "viewer", permissions: ["contacts.edit"] },
      { who: "soFunis", compat: "viewer", permissions: ["pipelines.manage"] },
      { who: "soView", compat: "admin", permissions: ["contacts.view"] },
    ]);
    await db.exec(`
      CREATE TABLE wacrm.pipelines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text);
      CREATE TABLE wacrm.pipeline_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid, name text);
      CREATE TABLE wacrm.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, pipeline_id uuid, title text);
      GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.pipelines, wacrm.pipeline_stages, wacrm.deals TO authenticated;
      ALTER TABLE wacrm.pipelines ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.pipeline_stages ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.deals ENABLE ROW LEVEL SECURITY;
      -- ANTES (017 + select por permissão da 305)
      CREATE POLICY pipelines_select ON wacrm.pipelines FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY pipelines_insert ON wacrm.pipelines FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY pipelines_update ON wacrm.pipelines FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY pipelines_delete ON wacrm.pipelines FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
      CREATE POLICY deals_select ON wacrm.deals FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY deals_insert ON wacrm.deals FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY deals_update ON wacrm.deals FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY deals_delete ON wacrm.deals FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
      CREATE POLICY pipeline_stages_select ON wacrm.pipeline_stages FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id)));
      CREATE POLICY pipeline_stages_modify ON wacrm.pipeline_stages FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id, 'admin'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id, 'admin')));
      INSERT INTO wacrm.pipelines (id, account_id, name) VALUES ('${P1}', '${ACC}', 'p1'), ('${id(702)}', '${ACC_B}', 'pb');
      INSERT INTO wacrm.pipeline_stages (id, pipeline_id, name) VALUES ('${S1}', '${P1}', 's1');
      INSERT INTO wacrm.deals (id, account_id, pipeline_id, title) VALUES ('${D1}', '${ACC}', '${P1}', 'd1');
    `);
    for (const who of everyone()) before[who] = await writeSnapshot(db, who, PROBES);

    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = NULL WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);
    await expect(db.exec(migration("348_deals_pipelines_write_rls_has_perm.sql"))).rejects.toThrow(/sem role_id/);
    await db.exec("ROLLBACK");
    await db.exec(`SET session_replication_role = replica; UPDATE wacrm.profiles SET role_id = (SELECT id FROM wacrm.account_roles WHERE key = 'viewer' AND account_id IS NULL) WHERE user_id = '${U.viewer}'; SET session_replication_role = DEFAULT;`);

    await db.exec(migration("348_deals_pipelines_write_rls_has_perm.sql"));
    for (const who of everyone()) after[who] = await writeSnapshot(db, who, PROBES);
  }, 200_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("cenário de hoje: agent+ escreve negócios; só admin+ escreve funis e etapas; visualizador e outra conta não escrevem", () => {
    expect(before.agent["deals.update"]).toBe("ok");
    expect(before.agent["pipelines.insert"]).toBe("negado");
    expect(before.admin["pipeline_stages.insert"]).toBe("ok");
    expect(before.viewer["deals.insert"]).toBe("negado");
    expect(before.other["deals.update"]).toBe("negado");
  });

  it("EQUIVALÊNCIA: nos 6 papéis de sistema e na outra conta o que cada um escreve é IDÊNTICO antes e depois (as telas continuam)", () => {
    for (const who of [...SYSTEM, "other"]) expect(after[who], who).toEqual(before[who]);
  });

  it("papel personalizado pelo catálogo: contacts.edit escreve só negócios; pipelines.manage só funis e etapas; só leitura (mesmo com nível admin) não escreve", () => {
    for (const k of ["deals.insert", "deals.update", "deals.delete"]) expect(after.soDeals[k], `soDeals ${k}`).toBe("ok");
    for (const k of ["pipelines.insert", "pipeline_stages.insert"]) expect(after.soDeals[k], `soDeals ${k}`).toBe("negado");
    for (const k of ["pipelines.insert", "pipelines.update", "pipeline_stages.insert", "pipeline_stages.update"]) expect(after.soFunis[k], `soFunis ${k}`).toBe("ok");
    expect(after.soFunis["deals.insert"]).toBe("negado");
    for (const [k, v] of Object.entries(after.soView)) expect(v, `soView ${k}`).toBe("negado");
  });

  it("pipeline_stages não tem mais policy FOR ALL", async () => {
    const rows = (await db.query<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = 'pipeline_stages' ORDER BY 1`)).rows;
    expect(rows.map((r) => `${r.policyname}:${r.cmd}`)).toEqual(["pipeline_stages_delete:DELETE", "pipeline_stages_insert:INSERT", "pipeline_stages_select:SELECT", "pipeline_stages_update:UPDATE"]);
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve EXATAMENTE a escrita de antes (todos os usuários); reaplicar funciona", async () => {
    await db.exec(headerRollback("348_deals_pipelines_write_rls_has_perm.sql"));
    for (const who of everyone()) expect(await writeSnapshot(db, who, PROBES), `${who} depois do rollback`).toEqual(before[who]);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations WHERE version LIKE '348%'`)).rows).toEqual([]);
    await db.exec(migration("348_deals_pipelines_write_rls_has_perm.sql"));
    for (const who of everyone()) expect(await writeSnapshot(db, who, PROBES), `${who} reaplicada`).toEqual(after[who]);
  });
});
