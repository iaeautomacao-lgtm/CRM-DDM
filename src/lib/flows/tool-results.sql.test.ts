// Migration 212: flow_run_tool_results — tabela FECHADA (RLS ligada, sem policy; só service_role) e cascata com o run.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;
const RUN = "00000000-0000-0000-0000-0000000000a1";

describe("migration 212 — flow_run_tool_results", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.flow_runs (id uuid PRIMARY KEY);
    `);
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/212_flow_run_tool_results.sql"), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
    await db.exec(sql);
    await db.exec(sql); // idempotente
    await db.exec(`INSERT INTO wacrm.flow_runs VALUES ('${RUN}')`);
  });
  afterAll(async () => {
    await db.close();
  });

  it("fechada: RLS ligada sem nenhuma policy; anon/authenticated sem acesso; service_role com acesso", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid = 'wacrm.flow_run_tool_results'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const policies = await db.query("SELECT 1 FROM pg_policies WHERE schemaname='wacrm' AND tablename='flow_run_tool_results'");
    expect(policies.rows).toHaveLength(0);
    const grants = await db.query<{ role: string; ok: boolean }>(`
      SELECT r AS role, has_table_privilege(r, 'wacrm.flow_run_tool_results', 'SELECT') AS ok
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r)`);
    expect(Object.fromEntries(grants.rows.map((g) => [g.role, g.ok]))).toEqual({ anon: false, authenticated: false, service_role: true });
  });

  it("guarda o bruto e some junto com o run (ON DELETE CASCADE)", async () => {
    await db.query("INSERT INTO wacrm.flow_run_tool_results(flow_run_id, account_id, node_key, tool_name, result) VALUES ($1, gen_random_uuid(), 'n', 'localizar_devedor', '[{\"cpf\":\"x\"}]')", [RUN]);
    expect((await db.query("SELECT 1 FROM wacrm.flow_run_tool_results")).rows).toHaveLength(1);
    await db.exec(`DELETE FROM wacrm.flow_runs WHERE id = '${RUN}'`);
    expect((await db.query("SELECT 1 FROM wacrm.flow_run_tool_results")).rows).toHaveLength(0);
  });
});
