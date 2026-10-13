// Migration 329: anon perde o GRANT ALL do schema wacrm (027); authenticated/service_role seguem iguais; peek_invitation do wacrm (se existir) fica para o anon.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { headerRollback, migration } from "./rls-fixture";

describe("migration 329 — REVOKE do anon no schema wacrm", { timeout: 60_000 }, () => {
  let db: PGlite;
  const tbl = async (role: string, t: string) => (await db.query<{ ok: boolean }>(`SELECT has_table_privilege('${role}', '${t}', 'SELECT') AS ok`)).rows[0].ok;
  const fn = async (role: string, f: string) => (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('${role}', '${f}'::regprocedure, 'EXECUTE') AS ok`)).rows[0].ok;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.contacts (id serial PRIMARY KEY, name text);
      CREATE FUNCTION wacrm.run_all_deal_aging_rules() RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
      CREATE FUNCTION wacrm.peek_invitation(p_token_hash text) RETURNS text AS $$ SELECT 'ok'::text $$ LANGUAGE sql;
      GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA wacrm TO anon, authenticated, service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA wacrm TO anon, authenticated, service_role;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA wacrm TO anon, authenticated, service_role;
    `);
  });
  afterAll(async () => {
    await db.close();
  });

  it("antes: anon lê tabelas e executa funções do wacrm (o furo da 027)", async () => {
    expect(await tbl("anon", "wacrm.contacts")).toBe(true);
    expect(await fn("anon", "wacrm.run_all_deal_aging_rules()")).toBe(true);
  });

  it("depois: anon sem tabela/função (nem objeto criado depois); authenticated e service_role intactos; peek_invitation do wacrm continua para o anon", async () => {
    await db.exec(migration("329_revoke_anon_wacrm.sql"));
    expect(await tbl("anon", "wacrm.contacts")).toBe(false);
    expect(await fn("anon", "wacrm.run_all_deal_aging_rules()")).toBe(false);
    for (const r of ["authenticated", "service_role"]) {
      expect(await tbl(r, "wacrm.contacts"), r).toBe(true);
      expect(await fn(r, "wacrm.run_all_deal_aging_rules()"), r).toBe(true);
    }
    expect(await fn("anon", "wacrm.peek_invitation(text)")).toBe(true);
    await db.exec(`CREATE TABLE wacrm.nova (id int)`);
    expect(await tbl("anon", "wacrm.nova")).toBe(false);
  });

  it("ROLLBACK do cabeçalho é executável e devolve o acesso ao anon; reaplicar funciona", async () => {
    await db.exec(headerRollback("329_revoke_anon_wacrm.sql"));
    expect(await tbl("anon", "wacrm.contacts")).toBe(true);
    await db.exec(migration("329_revoke_anon_wacrm.sql"));
    expect(await tbl("anon", "wacrm.contacts")).toBe(false);
  });
});
