import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

let db: PGlite;
const migration = readFileSync(resolve("supabase/migrations/157_tabulacao_ia_sugestao.sql"), "utf8");
const account = "00000000-0000-0000-0000-000000000001";
const otherAccount = "00000000-0000-0000-0000-000000000002";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA wacrm; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE wacrm.accounts(id uuid PRIMARY KEY);
    CREATE TABLE wacrm.tags(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
      kind text, codigo_tabulacao integer, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE wacrm.conversations(id uuid PRIMARY KEY);
    CREATE FUNCTION wacrm.is_account_member(uuid, text DEFAULT 'agent')
      RETURNS boolean LANGUAGE sql AS 'SELECT true';
    INSERT INTO wacrm.accounts VALUES ('${account}'), ('${otherAccount}');
  `);
  await db.exec(migration);
  await db.exec(migration);
}, 30_000);

afterAll(async () => { await db?.close(); });

it("índice parcial é idempotente, por conta, só de desfecho e com código", async () => {
  await db.exec(`
    INSERT INTO wacrm.tags(account_id, kind, codigo_tabulacao) VALUES
      ('${account}', 'outcome', 142), ('${otherAccount}', 'outcome', 142),
      ('${account}', 'contact', 142), ('${account}', 'contact', 142),
      ('${account}', 'outcome', NULL), ('${account}', 'outcome', NULL);
  `);
  await expect(db.exec(`INSERT INTO wacrm.tags(account_id, kind, codigo_tabulacao)
    VALUES ('${account}', 'outcome', 142)`)).rejects.toThrow(/duplicate key/);
  const { rows } = await db.query<{ indexdef: string }>(`
    SELECT indexdef FROM pg_indexes WHERE schemaname='wacrm' AND indexname='tags_outcome_account_codigo_key'
  `);
  expect(rows).toHaveLength(1);
  expect(rows[0].indexdef).toContain("UNIQUE INDEX");
});

it("duplicados produzem NOTICE, pulam só o índice e permitem reaplicar após correção", async () => {
  await db.exec(`
    DROP INDEX wacrm.tags_outcome_account_codigo_key;
    INSERT INTO wacrm.tags(account_id, kind, codigo_tabulacao) VALUES ('${account}', 'outcome', 142);
  `);
  const notices: string[] = [];
  await db.exec(migration, { onNotice: (notice) => notices.push(notice.message ?? "") });
  expect(notices.some((message) => message.includes("Códigos de tabulação duplicados"))).toBe(true);
  const index = await db.query("SELECT 1 FROM pg_indexes WHERE schemaname='wacrm' AND indexname='tags_outcome_account_codigo_key'");
  expect(index.rows).toHaveLength(0);
  const map = await db.query("SELECT 1 FROM wacrm.ai_exit_tag_outcome_map");
  expect(map.rows).toHaveLength(2); // demais passos da migration continuam
  await db.exec(`
    DELETE FROM wacrm.tags WHERE id IN (
      SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY account_id, codigo_tabulacao ORDER BY created_at, id) AS n
        FROM wacrm.tags WHERE kind='outcome' AND codigo_tabulacao IS NOT NULL) d WHERE n > 1
    );
  `);
  await db.exec(migration);
  const restored = await db.query("SELECT 1 FROM pg_indexes WHERE schemaname='wacrm' AND indexname='tags_outcome_account_codigo_key'");
  expect(restored.rows).toHaveLength(1);
});

it("trigger SECURITY DEFINER termina search_path em pg_temp e mantém seed funcional", async () => {
  const { rows } = await db.query<{ prosecdef: boolean; proconfig: string[] }>(`
    SELECT prosecdef, proconfig FROM pg_proc
    WHERE oid='wacrm.tg_seed_ai_exit_tag_outcome_map()'::regprocedure
  `);
  expect(rows[0].prosecdef).toBe(true);
  expect(rows[0].proconfig).toContain("search_path=wacrm, public, pg_temp");
  await db.exec(`INSERT INTO wacrm.tags(account_id, kind, codigo_tabulacao) VALUES ('${account}', 'outcome', 220)`);
  const mapping = await db.query<{ exit_tag: string; auto_close: boolean }>(`
    SELECT exit_tag, auto_close FROM wacrm.ai_exit_tag_outcome_map
    WHERE account_id='${account}' AND exit_tag='#RECUSA_CONFIRMADA'
  `);
  expect(mapping.rows).toEqual([{ exit_tag: "#RECUSA_CONFIRMADA", auto_close: false }]);
});
