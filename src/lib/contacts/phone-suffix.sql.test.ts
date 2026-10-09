// Migrations 314/314b/316b (auditoria de backend B-13 e B-14). PGlite com as migrations REAIS:
// - find_contacts_by_phone_suffix devolve só os contatos da conta com o mesmo sufixo de 8 dígitos, respeitando o RLS
//   de quem chama (SECURITY INVOKER), e o plano usa o índice de expressão da 314b (antes era LIKE '%…', sem índice);
// - o filtro de conversas por conta + período usa o índice da 316b.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const mig = (f: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", f), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const A = "0000000a-0000-0000-0000-000000000000";
const B = "0000000b-0000-0000-0000-000000000000";

let db: PGlite;
const plan = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");

describe("migrations 314/314b/316b — índices de contato por telefone e de conversas por período", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.contacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text, phone text NOT NULL,
        phone_normalized text GENERATED ALWAYS AS (regexp_replace(phone, '\\D', '', 'g')) STORED
      );
      CREATE INDEX idx_contacts_account ON wacrm.contacts (account_id);
      CREATE TABLE wacrm.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, created_at timestamptz NOT NULL);
      GRANT SELECT ON wacrm.contacts TO authenticated, service_role;
      -- RLS como em produção: o usuário só vê a conta dele (test.account)
      ALTER TABLE wacrm.contacts ENABLE ROW LEVEL SECURITY;
      CREATE POLICY contacts_select ON wacrm.contacts FOR SELECT TO authenticated
        USING (account_id = nullif(current_setting('test.account', true), '')::uuid);
      INSERT INTO wacrm.contacts (account_id, name, phone)
        SELECT CASE WHEN g % 2 = 0 THEN '${A}'::uuid ELSE '${B}'::uuid END, 'c' || g, '55119' || lpad(g::text, 8, '0')
          FROM generate_series(1, 4000) g;
      INSERT INTO wacrm.contacts (account_id, name, phone) VALUES
        ('${A}', 'alvo', '+55 (11) 98765-4321'), ('${A}', 'tronco', '5511087654321'), ('${B}', 'outra conta', '5511987654321');
      INSERT INTO wacrm.conversations (account_id, created_at)
        SELECT CASE WHEN g % 2 = 0 THEN '${A}'::uuid ELSE '${B}'::uuid END, now() - (g || ' minutes')::interval
          FROM generate_series(1, 4000) g;
    `);
    await db.exec(mig("314_contacts_phone_suffix_lookup.sql"));
    await db.exec(mig("314_contacts_phone_suffix_lookup.sql")); // idempotente
    await db.exec(mig("314b_contacts_phone_suffix_idx.sql"));
    await db.exec(mig("316b_conversations_account_created_idx.sql"));
    await db.exec(mig("316b_conversations_account_created_idx.sql")); // IF NOT EXISTS
    await db.exec("ANALYZE wacrm.contacts; ANALYZE wacrm.conversations;");
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("314: devolve só os contatos da conta com o mesmo sufixo (inclui variante de tronco); registra", async () => {
    const rows = (await db.query<{ name: string }>(`SELECT name FROM wacrm.find_contacts_by_phone_suffix($1, '87654321') ORDER BY name`, [A])).rows;
    expect(rows.map((r) => r.name)).toEqual(["alvo", "tronco"]);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '314_contacts_phone_suffix_lookup'`)).rows).toHaveLength(1);
  });

  it("314: SECURITY INVOKER — o usuário de outra conta não enxerga nada pelo RLS; anon não executa", async () => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('test.account', '${B}', false);`);
    try {
      const rows = (await db.query<{ name: string }>(`SELECT name FROM wacrm.find_contacts_by_phone_suffix($1, '87654321')`, [A])).rows;
      expect(rows).toEqual([]);
    } finally {
      await db.exec("RESET ROLE");
    }
    await db.exec("SET ROLE anon");
    try {
      await expect(db.query(`SELECT * FROM wacrm.find_contacts_by_phone_suffix('${A}', '87654321')`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });

  it("314b: os índices existem e são válidos", async () => {
    const idx = (
      await db.query<{ indexname: string; valid: boolean }>(
        `SELECT i.relname AS indexname, x.indisvalid AS valid FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
          WHERE i.relname IN ('idx_contacts_account_phone_suffix8', 'idx_conversations_account_created') ORDER BY 1`,
      )
    ).rows;
    expect(idx).toEqual([
      { indexname: "idx_contacts_account_phone_suffix8", valid: true },
      { indexname: "idx_conversations_account_created", valid: true },
    ]);
  });

  it("314b: a consulta da função usa o índice de expressão (antes: LIKE sem índice)", async () => {
    const p = await plan(`SELECT * FROM wacrm.contacts c WHERE c.account_id = $1 AND right(c.phone_normalized, 8) = '87654321'`, [A]);
    expect(p).toMatch(/idx_contacts_account_phone_suffix8/);
  });

  it("316b: conversas por conta + período usam o índice novo", async () => {
    const p = await plan(
      `SELECT id FROM wacrm.conversations WHERE account_id = $1 AND created_at >= now() - interval '1 hour' ORDER BY created_at DESC LIMIT 100`,
      [A],
    );
    expect(p).toMatch(/idx_conversations_account_created/);
  });
});
