// Migration 262 (PRD 21.4): flow_nodes_node_type_check passa a aceitar 'send_flow' SEM perder os tipos que já existiam (nem os só do banco).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = () => readFileSync(resolve(process.cwd(), "supabase/migrations/262_flow_send_flow_node.sql"), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

describe("migration 262 — nó send_flow", { timeout: 60_000 }, () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA wacrm;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.flow_nodes (id serial PRIMARY KEY, node_type text NOT NULL, node_key text);
      -- estilo da 065 + um tipo que só existe no banco vivo (send_webchat)
      ALTER TABLE wacrm.flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN ('start', 'send_message', 'send_template', 'end', 'send_webchat'));
    `);
  });
  afterEach(async () => {
    await db.close();
  });

  const insert = (type: string) => db.query(`INSERT INTO wacrm.flow_nodes (node_type) VALUES ($1)`, [type]);

  it("antes: send_flow é recusado; depois: aceito, e TODOS os tipos antigos (inclusive o só-do-banco) continuam aceitos", async () => {
    await expect(insert("send_flow")).rejects.toThrow(/check/i);
    await insert("send_webchat"); // linha existente continua válida
    await db.exec(migration());
    await insert("send_flow");
    for (const t of ["start", "send_message", "send_template", "end", "send_webchat"]) await insert(t);
    await expect(insert("tipo_inventado")).rejects.toThrow(/check/i);
  });

  it("idempotente: rodar de novo não muda a constraint nem falha; registra a versão", async () => {
    await db.exec(migration());
    const before = (await db.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'flow_nodes_node_type_check'`)).rows[0].d;
    await db.exec(migration());
    const after = (await db.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'flow_nodes_node_type_check'`)).rows[0].d;
    expect(after).toBe(before);
    expect((await db.query(`SELECT version FROM wacrm.schema_migrations`)).rows).toEqual([{ version: "262_flow_send_flow_node" }]);
  });

  it("aborta sem alterar nada se a constraint não existe ou tem formato inesperado", async () => {
    await db.exec(`ALTER TABLE wacrm.flow_nodes DROP CONSTRAINT flow_nodes_node_type_check`);
    await expect(db.exec(migration())).rejects.toThrow(/não existe/);
    await db.exec("ROLLBACK"); // a migration abre BEGIN; o erro deixa a transação abortada
    await db.exec(`ALTER TABLE wacrm.flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (length(node_type) > 0)`);
    await expect(db.exec(migration())).rejects.toThrow(/formato inesperado/);
    await db.exec("ROLLBACK");
    await expect(insert("send_flow")).resolves.toBeDefined(); // a constraint antiga ficou como estava
  });
});
