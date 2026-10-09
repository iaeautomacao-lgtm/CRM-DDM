// Migration 260 (PRD 21, PR-21.1): messages.flow_response, colunas de chave do Flow e wacrm.whatsapp_flows.
// PGlite com a migration REAL sobre um bootstrap mínimo (messages, whatsapp_config, accounts, current_account_id).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const UA = "00000000-0000-0000-0000-0000000000a1";
const CH_A = "00000000-0000-0000-0000-0000000000c1";
const CH_B = "00000000-0000-0000-0000-0000000000c2";

const BOOTSTRAP = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA wacrm; CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA wacrm, auth TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE wacrm.profiles (user_id uuid PRIMARY KEY, account_id uuid REFERENCES wacrm.accounts(id));
  CREATE FUNCTION wacrm.current_account_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public
    AS $$ SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1 $$;
  CREATE TABLE wacrm.whatsapp_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES wacrm.accounts(id), phone_number_id text);
  CREATE TABLE wacrm.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content_text text, interactive_reply_id text);
  CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
  GRANT SELECT ON ALL TABLES IN SCHEMA wacrm TO authenticated, service_role;
  INSERT INTO wacrm.accounts (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
  INSERT INTO wacrm.profiles (user_id, account_id) VALUES ('${UA}', '${A}');
  INSERT INTO wacrm.whatsapp_config (id, account_id, phone_number_id) VALUES ('${CH_A}', '${A}', 'pn-a'), ('${CH_B}', '${B}', 'pn-b');
  INSERT INTO wacrm.messages (content_text) VALUES ('mensagem antiga');
`;

describe("migration 260 — WhatsApp Flows", { timeout: 60_000 }, () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BOOTSTRAP);
    await db.exec(migration("260_whatsapp_flows.sql"));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  const cols = async (table: string) =>
    (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name=$1`, [table])).rows.map((r) => r.column_name);

  it("adiciona as colunas sem tocar nas linhas existentes", async () => {
    expect(await cols("messages")).toContain("flow_response");
    expect(await cols("whatsapp_config")).toEqual(expect.arrayContaining(["flows_public_key", "flows_private_key_enc"]));
    expect((await db.query(`SELECT content_text, flow_response FROM wacrm.messages`)).rows).toEqual([{ content_text: "mensagem antiga", flow_response: null }]);
  });

  it("flow_response guarda jsonb (consulta por campo)", async () => {
    await db.exec(`INSERT INTO wacrm.messages (content_text, flow_response) VALUES ('x', '{"parcelas":3}')`);
    expect((await db.query(`SELECT (flow_response ->> 'parcelas')::int AS p FROM wacrm.messages WHERE flow_response IS NOT NULL`)).rows).toEqual([{ p: 3 }]);
  });

  it("whatsapp_flows: status restrito, único por canal+flow, apaga com o canal", async () => {
    await db.exec(`INSERT INTO wacrm.whatsapp_flows (account_id, channel_id, meta_flow_id, name, status) VALUES ('${A}', '${CH_A}', 'F1', 'Renegociação', 'PUBLISHED')`);
    await expect(db.exec(`INSERT INTO wacrm.whatsapp_flows (account_id, channel_id, meta_flow_id, name, status) VALUES ('${A}', '${CH_A}', 'F2', 'x', 'INVENTADO')`)).rejects.toThrow(/check/i);
    await expect(db.exec(`INSERT INTO wacrm.whatsapp_flows (account_id, channel_id, meta_flow_id, name, status) VALUES ('${A}', '${CH_A}', 'F1', 'dup', 'DRAFT')`)).rejects.toThrow(/unique|duplicate/i);
    await db.exec(`INSERT INTO wacrm.whatsapp_flows (account_id, channel_id, meta_flow_id, name, status) VALUES ('${B}', '${CH_B}', 'F9', 'Da conta B', 'DRAFT')`);
    await db.exec(`DELETE FROM wacrm.whatsapp_config WHERE id = '${CH_B}'`);
    expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.whatsapp_flows WHERE account_id = '${B}'`)).rows[0]).toEqual({ n: 0 });
  });

  it("RLS: membro lê SÓ os flows da própria conta e não escreve", async () => {
    await db.exec(`INSERT INTO wacrm.whatsapp_flows (account_id, channel_id, meta_flow_id, name, status) VALUES ('${B}', '${CH_A}', 'F7', 'fora', 'DRAFT') ON CONFLICT DO NOTHING`);
    await db.exec(`SET ROLE authenticated; SELECT set_config('test.uid', '${UA}', false)`);
    try {
      const seen = (await db.query<{ account_id: string }>(`SELECT account_id FROM wacrm.whatsapp_flows`)).rows;
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen.map((r) => r.account_id))).toEqual(new Set([A]));
      await expect(db.exec(`INSERT INTO wacrm.whatsapp_flows (account_id, channel_id, meta_flow_id, name, status) VALUES ('${A}', '${CH_A}', 'F8', 'x', 'DRAFT')`)).rejects.toThrow(/permission denied/i);
      await expect(db.query(`UPDATE wacrm.whatsapp_flows SET name = 'hack'`)).rejects.toThrow(/permission denied/i);
      await expect(db.query(`DELETE FROM wacrm.whatsapp_flows`)).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec(`RESET ROLE`);
    }
  });

  it("anon não tem acesso à tabela", async () => {
    await db.exec(`SET ROLE anon`);
    try {
      await expect(db.query(`SELECT 1 FROM wacrm.whatsapp_flows`)).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec(`RESET ROLE`);
    }
  });

  it("registra a versão em schema_migrations e é idempotente", async () => {
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations`)).rows).toEqual([{ version: "260_whatsapp_flows" }]);
    await db.exec(migration("260_whatsapp_flows.sql"));
    expect((await db.query(`SELECT count(*)::int AS n FROM wacrm.schema_migrations`)).rows[0]).toEqual({ n: 1 });
    expect(await cols("messages")).toContain("flow_response");
  });
});
