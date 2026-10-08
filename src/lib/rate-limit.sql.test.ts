// Migration 221 (PRD 14, 14.9): contador de rate limit compartilhado no Postgres — a RPC wacrm.rate_limit_hit REAL no PGlite.
// Prova: janela fixa e contagem atômica, isolamento por chave, virada de janela, validação, tabela UNLOGGED e fechada,
// limpeza, idempotência, registro em schema_migrations — e, ligada ao checkRateLimit do app, que o limite vale entre "processos".

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { __resetRateLimitForTests, __setSharedBackendForTests, checkRateLimit, type SharedBackend } from "./rate-limit";

const migration = (file: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8").replace(/NOTIFY pgrst[^;]*;/g, "");

type Hit = { success: boolean; remaining: number; reset_at: Date | string };

describe("migration 221 — rate_limit_hit", { timeout: 60_000 }, () => {
  let db: PGlite;

  const hit = async (key: string, limit: number, windowS: number): Promise<Hit> =>
    (await db.query<Hit>(`SELECT * FROM wacrm.rate_limit_hit($1, $2, $3)`, [key, limit, windowS])).rows[0];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm;
      GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      CREATE TABLE wacrm.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, source text NOT NULL DEFAULT 'migration', checksum text);
    `);
    await db.exec(migration("221_rate_limit_shared.sql"));
  }, 60_000);
  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("conta numa janela fixa: permite `limit` e nega o resto; remaining decresce e reset_at é o fim da janela", async () => {
    const results: Hit[] = [];
    for (let i = 0; i < 5; i++) results.push(await hit("k:basico", 3, 3600));
    expect(results.map((r) => r.success)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
    const reset = new Date(results[0].reset_at).getTime();
    expect(reset).toBeGreaterThan(Date.now());
    expect(reset - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(new Date(results[4].reset_at).getTime()).toBe(reset); // mesma janela
    expect((reset / 1000) % 3600).toBe(0); // alinhada ao relógio do banco (todas as instâncias enxergam a mesma janela)
  });

  it("chaves independentes", async () => {
    for (let i = 0; i < 3; i++) await hit("k:a", 3, 3600);
    expect((await hit("k:a", 3, 3600)).success).toBe(false);
    expect((await hit("k:b", 3, 3600)).success).toBe(true);
  });

  it("atômico: 20 chamadas concorrentes com limite 5 → exatamente 5 permitidas", async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => hit("k:concorrente", 5, 3600)));
    expect(all.filter((r) => r.success)).toHaveLength(5);
    expect(all.filter((r) => !r.success)).toHaveLength(15);
  });

  it("virada de janela: depois do fim da janela o contador recomeça", async () => {
    expect((await hit("k:janela", 1, 1)).success).toBe(true);
    expect((await hit("k:janela", 1, 1)).success).toBe(false);
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await hit("k:janela", 1, 1)).success).toBe(true);
  });

  it.each([
    ["limite 0", ["k", 0, 60]],
    ["limite negativo", ["k", -1, 60]],
    ["janela 0", ["k", 5, 0]],
    ["janela maior que 1 dia", ["k", 5, 86_401]],
    ["chave vazia", ["", 5, 60]],
    ["chave longa demais", ["x".repeat(201), 5, 60]],
  ])("valida os argumentos: %s", async (_name, args) => {
    await expect(db.query(`SELECT * FROM wacrm.rate_limit_hit($1, $2, $3)`, args as unknown[])).rejects.toThrow(/rate_limit_hit/);
  });

  it("tabela UNLOGGED e fechada; só service_role executa a RPC", async () => {
    const { rows } = await db.query<{ relpersistence: string; rls: boolean }>(
      `SELECT relpersistence, relrowsecurity AS rls FROM pg_class WHERE oid = 'wacrm.rate_limit_buckets'::regclass`,
    );
    expect(rows[0]).toEqual({ relpersistence: "u", rls: true });
    try {
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`);
        await expect(db.query(`SELECT * FROM wacrm.rate_limit_hit('x', 1, 60)`)).rejects.toThrow();
        await expect(db.query(`SELECT * FROM wacrm.rate_limit_buckets`)).rejects.toThrow();
        await expect(db.query(`SELECT wacrm.rate_limit_cleanup()`)).rejects.toThrow();
        await db.exec("RESET ROLE");
      }
      await db.exec("SET ROLE service_role");
      expect((await db.query<Hit>(`SELECT * FROM wacrm.rate_limit_hit('k:svc', 2, 60)`)).rows[0].success).toBe(true);
    } finally {
      await db.exec("RESET ROLE");
    }
  });

  it("limpeza: rate_limit_cleanup apaga só janelas vencidas", async () => {
    await db.exec(`
      INSERT INTO wacrm.rate_limit_buckets (key, window_start, expires_at, count) VALUES
        ('velho:1', now() - interval '2 hours', now() - interval '1 hour', 3),
        ('velho:2', now() - interval '3 hours', now() - interval '2 hours', 9),
        ('vivo:1',  now(), now() + interval '1 hour', 1);
    `);
    const { rows } = await db.query<{ n: number }>(`SELECT wacrm.rate_limit_cleanup() AS n`);
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
    const left = await db.query<{ key: string }>(`SELECT key FROM wacrm.rate_limit_buckets WHERE key LIKE 'velho:%' OR key = 'vivo:1'`);
    expect(left.rows.map((r) => r.key)).toEqual(["vivo:1"]);
  });

  it("idempotente (reaplicar não zera contadores) e registra-se em schema_migrations", async () => {
    await hit("k:idem", 2, 3600);
    await db.exec(migration("221_rate_limit_shared.sql"));
    expect((await hit("k:idem", 2, 3600)).remaining).toBe(0); // o 2º hit: a contagem anterior sobreviveu
    const { rows } = await db.query<{ version: string; source: string }>(`SELECT version, source FROM wacrm.schema_migrations WHERE version = '221_rate_limit_shared'`);
    expect(rows).toEqual([{ version: "221_rate_limit_shared", source: "migration" }]);
  });

  it("pré-check: tabela com outro formato aborta sem alterar", async () => {
    const bad = new PGlite();
    await bad.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA wacrm; CREATE TABLE wacrm.accounts (id uuid); CREATE TABLE wacrm.rate_limit_buckets (algo text);
    `);
    await expect(bad.exec(migration("221_rate_limit_shared.sql"))).rejects.toThrow(/outro formato/);
    await bad.exec("ROLLBACK");
    await bad.close();
  });

  describe("ligado ao checkRateLimit do app (backend = a RPC real)", () => {
    const rpcBackend: SharedBackend = async (key, limit, windowSeconds) => {
      const r = await hit(key, limit, windowSeconds);
      return { success: r.success, remaining: r.remaining, resetAt: new Date(r.reset_at).getTime() };
    };

    it("vale ENTRE processos e SOBREVIVE a restart: o Map do processo zerado não libera o que o banco contou", async () => {
      __resetRateLimitForTests();
      __setSharedBackendForTests(rpcBackend);
      const options = { limit: 3, windowMs: 3_600_000 };
      for (let i = 0; i < 3; i++) expect((await checkRateLimit("app:restart", options)).success).toBe(true);
      expect((await checkRateLimit("app:restart", options)).success).toBe(false);
      // "processo novo": Map vazio, mesmo banco
      __resetRateLimitForTests();
      __setSharedBackendForTests(rpcBackend);
      expect((await checkRateLimit("app:restart", options)).success).toBe(false);
      __resetRateLimitForTests();
    });

    it("duas instâncias dividem UM orçamento (antes: cada uma tinha o seu)", async () => {
      const options = { limit: 4, windowMs: 3_600_000 };
      let granted = 0;
      for (let instance = 0; instance < 2; instance++) {
        __resetRateLimitForTests(); // Map próprio da "instância"
        __setSharedBackendForTests(rpcBackend);
        for (let i = 0; i < 4; i++) if ((await checkRateLimit("app:duas", options)).success) granted++;
      }
      expect(granted).toBe(4); // não 8
      __resetRateLimitForTests();
    });
  });
});
