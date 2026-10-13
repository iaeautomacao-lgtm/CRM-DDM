// Migration 328: as 5 funções de trigger passam a ter search_path fixo; o corpo e o comportamento não mudam.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { headerRollback, migration } from "./rls-fixture";

const NAMES = ["update_updated_at_column", "create_deal_for_new_contact", "sync_deal_title_on_contact_name_change", "auto_manage_chat_tags", "seed_automation_templates"];

describe("migration 328 — search_path nas funções de trigger", { timeout: 60_000 }, () => {
  let db: PGlite;
  const configs = async () =>
    (await db.query<{ proname: string; proconfig: string[] | null }>(`SELECT proname, proconfig FROM pg_proc WHERE proname = ANY($1) ORDER BY 1`, [NAMES])).rows;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA wacrm; CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.t (id int, updated_at timestamptz);
      CREATE FUNCTION public.update_updated_at_column() RETURNS trigger AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE FUNCTION wacrm.create_deal_for_new_contact() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
      CREATE FUNCTION wacrm.sync_deal_title_on_contact_name_change() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
      CREATE FUNCTION wacrm.auto_manage_chat_tags() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
      CREATE FUNCTION wacrm.seed_automation_templates() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
      CREATE TRIGGER u BEFORE INSERT ON wacrm.t FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    `);
  });
  afterAll(async () => {
    await db.close();
  });

  it("antes: nenhuma tem search_path", async () => {
    const rows = await configs();
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.proconfig, r.proname).toBeNull();
  });

  it("depois: as 5 têm search_path fixo com pg_temp por último; o trigger continua gravando updated_at", async () => {
    await db.exec(migration("328_trigger_functions_search_path.sql"));
    for (const r of await configs()) expect(r.proconfig, r.proname).toEqual(["search_path=wacrm, public, extensions, pg_temp"]);
    await db.exec(`INSERT INTO wacrm.t (id) VALUES (1)`);
    expect((await db.query<{ updated_at: string | null }>(`SELECT updated_at FROM wacrm.t`)).rows[0].updated_at).not.toBeNull();
  });

  it("ROLLBACK do cabeçalho é executável (remove o search_path); reaplicar funciona", async () => {
    await db.exec(headerRollback("328_trigger_functions_search_path.sql"));
    for (const r of await configs()) expect(r.proconfig, r.proname).toBeNull();
    await db.exec(migration("328_trigger_functions_search_path.sql"));
    for (const r of await configs()) expect(r.proconfig, r.proname).not.toBeNull();
  });
});
