import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertGlobalResponder } from "./convert";
import { AGENT_CONFIG_SPEC, validateAgentConfig } from "./schema";

const migration = readFileSync("supabase/migrations/177_ai_agent_profiles.sql", "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const AGENT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const V1 = "00000000-0000-0000-0000-000000000011";
const V2 = "00000000-0000-0000-0000-000000000012";
const VB = "00000000-0000-0000-0000-000000000013";
const RULE = "00000000-0000-0000-0000-000000000021";
const RULE_B = "00000000-0000-0000-0000-000000000022";
const RV = "00000000-0000-0000-0000-000000000031";
const RV_B = "00000000-0000-0000-0000-000000000032";
const TABLES = ["ai_agents", "ai_agent_versions", "ai_rules", "ai_rule_versions", "ai_agent_rules", "ai_agent_tools", "ai_agent_knowledge"];
let db: PGlite;
const converted = (account_id = A) => convertGlobalResponder({ account_id, enabled: true, api_provider: "openai" });

async function version(id: string, agent = AGENT, account = A, num = 1, composition = "legacy_v1") {
  const data = converted(account);
  return db.query("INSERT INTO wacrm.ai_agent_versions(id,account_id,agent_id,version,config,prompt_content,composition,config_hash) VALUES ($1,$2,$3,$4,$5,'prompt',$6,$7)",
    [id, account, agent, num, JSON.stringify(data.config), composition, data.hash]);
}
async function as(role: string, sql: string) {
  await db.exec(`SET ROLE ${role}`);
  try { return await db.query(sql); } finally { await db.exec("RESET ROLE"); }
}

describe("177 — perfis, versões e vínculos account-scoped", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon,authenticated,service_role;
      CREATE TABLE wacrm.accounts(id uuid PRIMARY KEY); INSERT INTO wacrm.accounts VALUES ('${A}'),('${B}');`);
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(`INSERT INTO wacrm.ai_agents(id,account_id,name) VALUES ('${AGENT}','${A}','global'),('${OTHER}','${B}','global');
      INSERT INTO wacrm.ai_rules(id,account_id,name) VALUES ('${RULE}','${A}','regra'),('${RULE_B}','${B}','regra');
      INSERT INTO wacrm.ai_rule_versions(id,account_id,rule_id,version,content) VALUES ('${RV}','${A}','${RULE}',1,'r'),('${RV_B}','${B}','${RULE_B}',1,'b');`);
    await version(V1); await version(V2, AGENT, A, 2, "sections_v1"); await version(VB, OTHER, B);
  }, 30000);
  afterAll(async () => { await db?.close(); });

  it("descritor SQL idêntico ao TS e checagem de tipos/opções no banco", async () => {
    expect((await db.query<{ schema: unknown }>("SELECT wacrm.ai_agent_schema_v1() AS schema")).rows[0].schema).toEqual(AGENT_CONFIG_SPEC);
    const valid = converted().config;
    const candidates = [valid, {}, null, { ...valid, schema_version: 2 }, { ...valid, llm: { temperature: null } },
      { ...valid, llm: { temperature: 2.1 } }, { ...valid, llm: { temperature: 0 } },
      { ...valid, protections: { ...valid.protections, opt_out: false } },
      { ...valid, knowledge: { ...valid.knowledge, rag_external: { enabled: true } } },
      { ...valid, tools: [{ enabled: false }] },
    ];
    for (const config of candidates) {
      const result = await db.query<{ valid: boolean }>("SELECT wacrm.ai_agent_config_v1_valid($1::jsonb) AS valid", [JSON.stringify(config)]);
      expect(result.rows[0].valid).toBe(validateAgentConfig(config).success);
    }
    await expect(db.query("INSERT INTO wacrm.ai_agent_versions(account_id,agent_id,version,config,prompt_content,composition,config_hash) VALUES ($1,$2,3,$3,'p','legacy_v1',$4)",
      [A, AGENT, JSON.stringify({ ...valid, schema_version: 2 }), "a".repeat(64)])).rejects.toThrow(/config_check/);
  });
  it("mesmo nome pode existir em outra conta, duplicata na própria é recusada", async () => {
    await expect(db.exec(`INSERT INTO wacrm.ai_agents(account_id,name) VALUES ('${A}','global')`)).rejects.toThrow(/unique/);
    await expect(db.exec(`INSERT INTO wacrm.ai_rules(account_id,name) VALUES ('${A}','regra')`)).rejects.toThrow(/unique/);
  });
  it("FKs recusam versão/regra de outra conta e publish de outro agente", async () => {
    await expect(version("00000000-0000-0000-0000-000000000014", OTHER, A)).rejects.toThrow(/foreign key/);
    await expect(db.exec(`INSERT INTO wacrm.ai_agent_rules VALUES ('${A}','${V1}','${RV_B}',0,true)`)).rejects.toThrow(/foreign key/);
    await expect(db.exec(`UPDATE wacrm.ai_agents SET published_version_id='${VB}' WHERE id='${AGENT}'`)).rejects.toThrow(/não pertence/);
    const configB = converted(B).config;
    await expect(db.query("INSERT INTO wacrm.ai_agent_versions(account_id,agent_id,version,config,prompt_content,composition,config_hash) VALUES ($1,$2,4,$3,'p','legacy_v1',$4)",
      [A, AGENT, JSON.stringify(configB), "b".repeat(64)])).rejects.toThrow(/check/);
  });
  it("conteúdo das versões é imutável até para service_role", async () => {
    await expect(as("service_role", `UPDATE wacrm.ai_agent_versions SET prompt_content='alterado' WHERE id='${V1}'`)).rejects.toThrow(/imutável/);
    await expect(as("service_role", `DELETE FROM wacrm.ai_agent_versions WHERE id='${V1}'`)).rejects.toThrow(/imutável/);
    await expect(as("service_role", `UPDATE wacrm.ai_rule_versions SET content='outra' WHERE id='${RV}'`)).rejects.toThrow(/imutável/);
  });
  it("vínculos ordenados, conhecimento e TODO-176 sem dependência da tabela ai_tools", async () => {
    await db.exec(`INSERT INTO wacrm.ai_agent_rules VALUES ('${A}','${V2}','${RV}',1,true);
      INSERT INTO wacrm.ai_agent_tools VALUES ('${A}','${V2}','00000000-0000-0000-0000-000000000041',0,true);
      INSERT INTO wacrm.ai_agent_knowledge VALUES ('${A}','${V2}','legacy_account_all',NULL);`);
    await expect(db.exec(`INSERT INTO wacrm.ai_agent_rules VALUES ('${A}','${V2}','${RV}',2,true)`)).rejects.toThrow(/unique/);
    await expect(db.exec(`INSERT INTO wacrm.ai_agent_tools VALUES ('${B}','${V2}','00000000-0000-0000-0000-000000000042',0,true)`)).rejects.toThrow(/foreign key/);
    await expect(db.exec(`UPDATE wacrm.ai_agent_knowledge SET file_ids=ARRAY['${RV}']::uuid[] WHERE agent_version_id='${V2}'`)).rejects.toThrow(/check/);
    const fks = await db.query<{ target: string }>("SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid='wacrm.ai_agent_tools'::regclass AND contype='f'");
    expect(fks.rows).toEqual([{ target: "wacrm.ai_agent_versions" }]);
  });
  it("publicar sela vínculos; rollback não permite editar a versão antiga", async () => {
    await db.exec(`UPDATE wacrm.ai_agents SET published_version_id='${V2}' WHERE id='${AGENT}'`);
    await expect(db.exec(`UPDATE wacrm.ai_agent_rules SET enabled=false WHERE agent_version_id='${V2}'`)).rejects.toThrow(/imutável/);
    await expect(db.exec(`DELETE FROM wacrm.ai_agent_tools WHERE agent_version_id='${V2}'`)).rejects.toThrow(/imutável/);
    await expect(db.exec(`UPDATE wacrm.ai_agent_knowledge SET selection_mode='explicit',file_ids=ARRAY[]::uuid[] WHERE agent_version_id='${V2}'`)).rejects.toThrow(/imutável/);
    await db.exec(`UPDATE wacrm.ai_agents SET published_version_id='${V1}' WHERE id='${AGENT}'`);
    await expect(db.exec(`UPDATE wacrm.ai_agent_rules SET position=2 WHERE agent_version_id='${V2}'`)).rejects.toThrow(/imutável/);
    await expect(db.exec(`INSERT INTO wacrm.ai_agent_tools VALUES ('${A}','${V1}','${RV}',0,false)`)).rejects.toThrow(/imutável/);
    await db.exec(`UPDATE wacrm.ai_agents SET enabled=false WHERE id='${AGENT}'`);
    expect((await db.query<{ enabled: boolean }>(`SELECT enabled FROM wacrm.ai_agents WHERE id='${AGENT}'`)).rows[0].enabled).toBe(false);
    await db.exec(migration); // reaplicar com versões já publicadas mantém conteúdo e vínculos
  });
  it("legacy_v1 não pode publicar regras ativas", async () => {
    await db.exec(`INSERT INTO wacrm.ai_agent_rules VALUES ('${B}','${VB}','${RV_B}',0,true)`);
    await expect(db.exec(`UPDATE wacrm.ai_agents SET published_version_id='${VB}' WHERE id='${OTHER}'`)).rejects.toThrow(/rules/);
  });
  it("browser não tem SELECT/INSERT/UPDATE/DELETE, nem EXECUTE; RLS habilitada", async () => {
    for (const table of TABLES) {
      for (const role of ["anon", "authenticated"]) {
        for (const sql of [`SELECT * FROM wacrm.${table}`, `DELETE FROM wacrm.${table}`, `UPDATE wacrm.${table} SET account_id='${B}'`, `INSERT INTO wacrm.${table}(account_id) VALUES ('${A}')`]) {
          await expect(as(role, sql)).rejects.toThrow(/permission denied/);
        }
      }
      expect((await as("service_role", `SELECT * FROM wacrm.${table}`)).rows.length).toBeGreaterThanOrEqual(0);
    }
    await expect(as("authenticated", "SELECT wacrm.ai_agent_schema_v1()")).rejects.toThrow(/permission denied/);
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='wacrm'::regnamespace AND relname=ANY($1)", [TABLES]);
    expect(rls.rows).toHaveLength(TABLES.length);
    expect(rls.rows.every((row) => row.relrowsecurity)).toBe(true);
  });
  it("cascade da conta remove catálogos/versões/vínculos inclusive publicados", async () => {
    await db.exec(`DELETE FROM wacrm.accounts WHERE id='${A}'`);
    for (const table of TABLES) expect((await db.query(`SELECT * FROM wacrm.${table} WHERE account_id='${A}'`)).rows).toHaveLength(0);
  });
});
