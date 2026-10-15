// Migration 363: is_account_member(account_id) por linha → my_account_ids() avaliado uma vez. O que cada usuário lê tem de ser IDÊNTICO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, asUser, createRolesDb, headerRollback, migration } from "./rls-fixture";

type Snap = { deals: string[]; fila: string[]; metricas: string[] };

describe("migration 363 — membership da RLS de leitura em initplan", { timeout: 180_000 }, () => {
  let db: PGlite;
  const before: Record<string, Snap> = {};
  const after: Record<string, Snap> = {};
  const everyone = () => [...SYSTEM, "other", "semNada"];
  const read = async (who: string): Promise<Snap> => {
    const q = async (t: string) => (await asUser<{ k: string }>(db, who, `SELECT title AS k FROM wacrm.${t}`)).map((r) => r.k).sort();
    return { deals: await q("deals"), fila: await q("disp_message_queue"), metricas: await q("campaign_metrics") };
  };
  const policies = async () =>
    (await db.query<{ policyname: string; qual: string }>(`SELECT policyname, qual FROM pg_policies WHERE schemaname='wacrm' AND policyname IN ('deals_select','disp_message_queue_select','campaign_metrics_select') ORDER BY 1`)).rows;

  beforeAll(async () => {
    db = await createRolesDb([{ who: "semNada", compat: "agent", permissions: ["inbox.view"] }]);
    await db.exec(`
      CREATE TABLE wacrm.pipelines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, archived_at timestamptz);
      CREATE TABLE wacrm.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, pipeline_id uuid, title text);
      CREATE TABLE wacrm.disp_message_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, title text);
      CREATE TABLE wacrm.campaign_metrics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, title text);
      GRANT SELECT ON wacrm.pipelines, wacrm.deals, wacrm.disp_message_queue, wacrm.campaign_metrics TO authenticated;
      ALTER TABLE wacrm.deals ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.disp_message_queue ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.campaign_metrics ENABLE ROW LEVEL SECURITY;
      ALTER TABLE wacrm.pipelines ENABLE ROW LEVEL SECURITY;
      CREATE POLICY pipelines_all ON wacrm.pipelines FOR SELECT USING (true);
      -- ANTES (305/340): is_account_member por linha + permissão em initplan + funil ativo (a permissão do catálogo da fixture é inbox.view)
      CREATE POLICY deals_select ON wacrm.deals FOR SELECT USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('inbox.view')) AND EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = deals.pipeline_id AND p.archived_at IS NULL));
      CREATE POLICY disp_message_queue_select ON wacrm.disp_message_queue FOR SELECT USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('inbox.view')));
      CREATE POLICY campaign_metrics_select ON wacrm.campaign_metrics FOR SELECT USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('inbox.view')));
      INSERT INTO wacrm.pipelines (id, account_id) VALUES ('00000000-0000-0000-0000-000000000901', '${ACC}'), ('00000000-0000-0000-0000-000000000902', '${ACC_B}');
      INSERT INTO wacrm.deals (account_id, pipeline_id, title) VALUES ('${ACC}', '00000000-0000-0000-0000-000000000901', 'dA'), ('${ACC_B}', '00000000-0000-0000-0000-000000000902', 'dB');
      INSERT INTO wacrm.disp_message_queue (account_id, title) VALUES ('${ACC}', 'qA'), ('${ACC_B}', 'qB');
      INSERT INTO wacrm.campaign_metrics (account_id, title) VALUES ('${ACC}', 'mA'), ('${ACC_B}', 'mB');
    `);
    for (const who of everyone()) before[who] = await read(who);
    await db.exec(migration("363_perf_rls_membership_initplan.sql"));
    for (const who of everyone()) after[who] = await read(who);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("a regra de hoje: membro lê só a própria conta; o visualizador do catálogo da fixture (sem inbox.view) não lê nada", () => {
    expect(before.agent).toEqual({ deals: ["dA"], fila: ["qA"], metricas: ["mA"] });
    expect(before.other).toEqual({ deals: ["dB"], fila: ["qB"], metricas: ["mB"] });
    expect(before.semNada.deals).toEqual(["dA"]);
    expect(before.viewer).toEqual({ deals: [], fila: [], metricas: [] });
  });

  it("EQUIVALÊNCIA: todo usuário lê EXATAMENTE o mesmo antes e depois", () => {
    for (const who of everyone()) expect(after[who], who).toEqual(before[who]);
  });

  it("as 3 policies passam a usar my_account_ids e mantêm permissão e funil ativo; sem is_account_member por linha", async () => {
    const rows = await policies();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.qual, r.policyname).toContain("my_account_ids");
      expect(r.qual, r.policyname).not.toContain("is_account_member");
      expect(r.qual, r.policyname).toContain("has_perm");
    }
    expect(rows.find((r) => r.policyname === "deals_select")!.qual).toContain("archived_at");
  });

  it("idempotente: reaplicar não muda nada", async () => {
    const antes = await policies();
    await db.exec(migration("363_perf_rls_membership_initplan.sql"));
    expect(await policies()).toEqual(antes);
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve o retrato e a expressão de antes; reaplicar funciona", async () => {
    await db.exec(headerRollback("363_perf_rls_membership_initplan.sql"));
    for (const who of everyone()) expect(await read(who), `${who} depois do rollback`).toEqual(before[who]);
    for (const r of await policies()) expect(r.qual, r.policyname).toContain("is_account_member");
    expect((await db.query(`SELECT to_regprocedure('wacrm.my_account_ids()') AS f`)).rows[0]).toEqual({ f: null });
    await db.exec(migration("363_perf_rls_membership_initplan.sql"));
    for (const who of everyone()) expect(await read(who), `${who} reaplicada`).toEqual(after[who]);
  });
});
