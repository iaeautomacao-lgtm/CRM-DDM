// Migration 335: api_keys_select e ai_config_select pelo catálogo. Papéis de sistema: retrato idêntico; papel personalizado sem chave deixa de ler.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, SYSTEM, asUser, createRolesDb, headerRollback, migration } from "./rls-fixture";

type Snap = { api_keys: string[]; ai_config: string[] };

describe("migration 335 — api_keys e ai_config por permissão", { timeout: 180_000 }, () => {
  let db: PGlite;
  const before: Record<string, Snap> = {};
  const after: Record<string, Snap> = {};
  const everyone = () => [...SYSTEM, "other", "soIa", "semNada"];
  const read = async (who: string): Promise<Snap> => ({
    api_keys: (await asUser<{ k: string }>(db, who, `SELECT account_id::text AS k FROM wacrm.api_keys`)).map((r) => r.k).sort(),
    ai_config: (await asUser<{ k: string }>(db, who, `SELECT account_id::text AS k FROM wacrm.ai_config`)).map((r) => r.k).sort(),
  });

  beforeAll(async () => {
    db = await createRolesDb([
      { who: "soIa", compat: "agent", permissions: ["ai.config"] },
      { who: "semNada", compat: "agent", permissions: ["inbox.view"] },
    ]);
    await db.exec(`
      CREATE TABLE wacrm.api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text);
      CREATE TABLE wacrm.ai_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, enabled boolean DEFAULT true);
      GRANT SELECT ON wacrm.api_keys, wacrm.ai_config TO authenticated;
      ALTER TABLE wacrm.api_keys ENABLE ROW LEVEL SECURITY; ALTER TABLE wacrm.ai_config ENABLE ROW LEVEL SECURITY;
      CREATE POLICY api_keys_select ON wacrm.api_keys FOR SELECT USING (wacrm.is_account_member(account_id));
      CREATE POLICY ai_config_select ON wacrm.ai_config FOR SELECT USING (wacrm.is_account_member(account_id));
      INSERT INTO wacrm.api_keys (account_id, name) VALUES ('${ACC}', 'k1'), ('${ACC_B}', 'k2');
      INSERT INTO wacrm.ai_config (account_id) VALUES ('${ACC}'), ('${ACC_B}');
    `);
    for (const who of everyone()) before[who] = await read(who);
    await db.exec(migration("335_api_keys_ai_config_select_has_perm.sql"));
    for (const who of everyone()) after[who] = await read(who);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("a regra de hoje: qualquer membro lê as duas tabelas da própria conta", () => {
    expect(before.viewer.api_keys).toEqual([ACC]);
    expect(before.semNada.ai_config).toEqual([ACC]);
    expect(before.other.api_keys).toEqual([ACC_B]);
  });

  it("EQUIVALÊNCIA: nos papéis de sistema e na outra conta o que cada um lê é IDÊNTICO antes e depois", () => {
    for (const who of [...SYSTEM, "other"]) expect(after[who], who).toEqual(before[who]);
  });

  it("papel personalizado: só ai.config lê ai_config e não lê api_keys; sem nenhuma chave não lê nada", () => {
    expect(after.soIa.ai_config).toEqual([ACC]);
    expect(after.soIa.api_keys).toEqual([]);
    expect(after.semNada).toEqual({ api_keys: [], ai_config: [] });
  });

  it("ROLLBACK do cabeçalho é SQL executável: devolve o retrato de antes para todos; reaplicar funciona", async () => {
    await db.exec(headerRollback("335_api_keys_ai_config_select_has_perm.sql"));
    for (const who of everyone()) expect(await read(who), `${who} depois do rollback`).toEqual(before[who]);
    await db.exec(migration("335_api_keys_ai_config_select_has_perm.sql"));
    for (const who of everyone()) expect(await read(who), `${who} reaplicada`).toEqual(after[who]);
  });
});
