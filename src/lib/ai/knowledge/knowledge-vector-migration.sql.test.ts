// Migration 215 (TASK1-D, RAG vetorial). O PGlite do projeto NÃO tem a extensão vector: aqui se prova o aborto
// limpo sem ela e o descritor novo do perfil de agente; o teste da busca (tabela, função, isolamento por conta)
// só roda num Postgres que tenha a extensão (pula sozinho no PGlite).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { AGENT_CONFIG_SPEC, validateAgentConfig } from "@/lib/ai/agents/schema";
import { convertGlobalResponder } from "@/lib/ai/agents/convert";

const file = (name: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");
const M215 = file("215_knowledge_vector.sql");
/** Só o bloco do descritor (testável sem a extensão). */
const DESCRIPTOR_215 = M215.slice(M215.indexOf("-- >>> descritor 215"), M215.indexOf("-- <<< descritor 215"));

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

const hasVector = await (async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE EXTENSION vector");
    return true;
  } catch {
    return false;
  } finally {
    await db.close();
  }
})();

describe("215 — sem a extensão vector", { timeout: 60_000 }, () => {
  it.skipIf(hasVector)("aborta com mensagem clara e não muda nada", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE SCHEMA wacrm; CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);`);
      await expect(db.exec(M215)).rejects.toThrow(/extensão vector \(pgvector\) não está disponível/);
      await db.exec("ROLLBACK").catch(() => undefined);
      expect((await db.query<{ t: string | null }>(`SELECT to_regclass('wacrm.knowledge_chunks')::text AS t`)).rows[0].t).toBeNull();
    } finally {
      await db.close();
    }
  });
});

describe("215 — descritor do perfil de agente com knowledge.vector", { timeout: 60_000 }, () => {
  it("o descritor SQL é idêntico ao TS e o banco aceita/recusa knowledge.vector como o app", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
        CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);`);
      await db.exec(file("177_ai_agent_profiles.sql"));
      await db.exec(DESCRIPTOR_215);
      expect((await db.query<{ s: unknown }>("SELECT wacrm.ai_agent_schema_v1() AS s")).rows[0].s).toEqual(AGENT_CONFIG_SPEC);

      const valid = convertGlobalResponder({ account_id: A, api_provider: "openai", enabled: true }).config;
      const candidates = [
        valid,
        { ...valid, knowledge: { ...valid.knowledge, vector: { enabled: true } } },
        { ...valid, knowledge: { ...valid.knowledge, vector: { enabled: true, top_k: 6, min_similarity: 0.3 } } },
        { ...valid, knowledge: { ...valid.knowledge, vector: { enabled: true, top_k: 0 } } },
        { ...valid, knowledge: { ...valid.knowledge, vector: { enabled: true, top_k: 21 } } },
        { ...valid, knowledge: { ...valid.knowledge, vector: { enabled: true, min_similarity: 1.5 } } },
        { ...valid, knowledge: { ...valid.knowledge, vector: { top_k: 3 } } },
        { ...valid, knowledge: { ...valid.knowledge, vector: { enabled: true, extra: 1 } } },
      ];
      for (const config of candidates) {
        const sql = (await db.query<{ ok: boolean }>("SELECT wacrm.ai_agent_json_matches($1::jsonb, wacrm.ai_agent_schema_v1()) AS ok", [JSON.stringify(config)])).rows[0].ok;
        expect(sql, JSON.stringify(config.knowledge.vector ?? null)).toBe(validateAgentConfig(config).success);
      }
      expect(validateAgentConfig(candidates[2]).success).toBe(true);
      expect(validateAgentConfig(candidates[3]).success).toBe(false);
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!hasVector)("215 — busca vetorial (só com a extensão vector)", { timeout: 60_000 }, () => {
  it("trechos fechados, busca só na conta/arquivos pedidos, ordem por cosseno e similaridade mínima", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA wacrm; CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY);
        INSERT INTO wacrm.accounts VALUES ('${A}'), ('${B}');
        CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
        CREATE TABLE wacrm.knowledge_base_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, name text, content text, char_count integer);`);
      await db.exec(file("177_ai_agent_profiles.sql"));
      await db.exec(M215);
      await db.exec(M215); // idempotente
      const v = (x: number, y: number) => `[${[x, y, ...Array(1534).fill(0)].join(",")}]`;
      await db.exec(`
        INSERT INTO wacrm.knowledge_base_files (id, account_id, name, content) VALUES
          ('10000000-0000-0000-0000-000000000001', '${A}', 'a1', 'x'), ('10000000-0000-0000-0000-000000000002', '${A}', 'a2', 'y'),
          ('10000000-0000-0000-0000-000000000003', '${B}', 'b1', 'z');
        INSERT INTO wacrm.knowledge_chunks (account_id, file_id, chunk_index, content, embedding, model) VALUES
          ('${A}', '10000000-0000-0000-0000-000000000001', 0, 'perto', '${v(1, 0)}', 'm'),
          ('${A}', '10000000-0000-0000-0000-000000000001', 1, 'longe', '${v(0, 1)}', 'm'),
          ('${A}', '10000000-0000-0000-0000-000000000002', 0, 'outro arquivo', '${v(1, 0.1)}', 'm'),
          ('${B}', '10000000-0000-0000-0000-000000000003', 0, 'outra conta', '${v(1, 0)}', 'm');`);
      const rows = (
        await db.query<{ content: string; similarity: number }>(
          `SELECT content, similarity FROM wacrm.match_knowledge_chunks($1, ARRAY['10000000-0000-0000-0000-000000000001']::uuid[], $2, 5, 0.5)`,
          [A, v(1, 0)],
        )
      ).rows;
      expect(rows.map((r) => r.content)).toEqual(["perto"]);
      const all = (await db.query<{ content: string }>(`SELECT content FROM wacrm.match_knowledge_chunks($1, NULL, $2, 5, 0)`, [A, v(1, 0)])).rows;
      expect(all.map((r) => r.content)).toEqual(["perto", "outro arquivo", "longe"]);
      await db.exec("SET ROLE authenticated");
      await expect(db.query("SELECT count(*) FROM wacrm.knowledge_chunks")).rejects.toThrow();
      await db.exec("RESET ROLE");
      await db.exec(`DELETE FROM wacrm.knowledge_base_files WHERE id = '10000000-0000-0000-0000-000000000001'`);
      expect((await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM wacrm.knowledge_chunks WHERE account_id = '${A}'`)).rows[0].c).toBe(1);
      await db.exec(`SELECT wacrm.ai_embedding_usage_add('${A}', 3, 30); SELECT wacrm.ai_embedding_usage_add('${A}', 1, 5);`);
      expect((await db.query(`SELECT embeddings::int, tokens::int FROM wacrm.ai_embedding_usage WHERE account_id = '${A}'`)).rows).toEqual([{ embeddings: 4, tokens: 35 }]);
    } finally {
      await db.close();
    }
  });
});
