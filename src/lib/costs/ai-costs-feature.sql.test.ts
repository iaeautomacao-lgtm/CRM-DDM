// Migration 380: relatório de custo de IA por funcionalidade (CREATE OR REPLACE da RPC da 378). PGlite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, createRolesDb, headerRollback, migration } from "@/lib/security/rls-fixture";

type Row = { sku?: string; feature?: string; requests: number; input_tokens: number; output_tokens: number; cached_input_tokens: number; priced_usd: number; unpriced: number };
type Report = { ai: Row[]; by_feature?: Row[]; by_feature_model?: Row[] };

describe("migration 380 — custo de IA por funcionalidade", { timeout: 180_000 }, () => {
  let db: PGlite;
  const report = async (acc: string, month: string) =>
    (await db.query<{ r: Report }>(`SELECT wacrm.get_monthly_ai_cost_report($1::uuid, $2::date) AS r`, [acc, month])).rows[0].r;
  const usage = (acc: string, req: string, model: string, feature: string, i: number, o: number, c: number, at: string) =>
    db.query(
      `INSERT INTO wacrm.ai_token_usage (account_id, request_id, provider, model, feature, input_tokens, output_tokens, cached_input_tokens, occurred_at) VALUES ($1,$2,'openai',$3,$4,$5,$6,$7,$8::timestamptz)`,
      [acc, req, model, feature, i, o, c, at],
    );
  const rate = (sku: string, inp: number, out: number, cached: number | null) =>
    db.query(`INSERT INTO wacrm.cost_rates (account_id, source, sku, effective_from, currency, input_per_million, cached_input_per_million, output_per_million) VALUES ($1,'ai',$2,'2026-01-01','USD',$3,$4,$5)`, [ACC, sku, inp, cached, out]);
  const sum = (rows: Row[] | undefined, key: keyof Row) => (rows ?? []).reduce((s, r) => s + Number(r[key]), 0);

  beforeAll(async () => {
    db = await createRolesDb();
    await db.exec(migration("378_ai_costs.sql"));
    await rate("openai:gpt-4o-mini", 1, 2, 0.5);
    await rate("openai:caro", 10, 20, null);
    await usage(ACC, "a1", "gpt-4o-mini", "responder", 1_000_000, 500_000, 400_000, "2026-10-05T12:00:00Z");
    await usage(ACC, "a2", "caro", "responder", 100_000, 10_000, 0, "2026-10-06T12:00:00Z");
    await usage(ACC, "a3", "gpt-4o-mini", "sentiment", 200_000, 1_000, 0, "2026-10-07T12:00:00Z");
    await usage(ACC, "a4", "sem-tarifa", "acordo", 1000, 10, 0, "2026-10-08T12:00:00Z");
    await usage(ACC, "a5", "gpt-4o-mini", "responder", 10, 1, 0, "2026-09-10T12:00:00Z");
    await usage(ACC_B, "b1", "gpt-4o-mini", "responder", 9_000_000, 9_000_000, 0, "2026-10-05T12:00:00Z");
    // saída de referência da 378 (ANTES da 380), para provar que 'ai' não muda
    (globalThis as { __before378?: Report }).__before378 = await report(ACC, "2026-10-01");
    await db.exec(migration("380_ai_costs_by_feature.sql"));
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("'ai' continua idêntico ao da 378 e o retorno ganha by_feature e by_feature_model", async () => {
    const before = (globalThis as { __before378?: Report }).__before378!;
    const after = await report(ACC, "2026-10-01");
    expect(Object.keys(before)).toEqual(["ai"]);
    expect(after.ai).toEqual(before.ai);
    expect(Object.keys(after).sort()).toEqual(["ai", "by_feature", "by_feature_model"]);
  });

  it("por funcionalidade: soma == total, mesma regra de tarifa, 'sem preço' contado e ordenado por valor", async () => {
    const r = await report(ACC, "2026-10-01");
    for (const key of ["requests", "input_tokens", "output_tokens", "cached_input_tokens", "unpriced"] as const) expect(sum(r.by_feature, key)).toBe(sum(r.ai, key));
    expect(sum(r.by_feature, "priced_usd")).toBeCloseTo(sum(r.ai, "priced_usd"), 8);
    expect(sum(r.by_feature_model, "priced_usd")).toBeCloseTo(sum(r.ai, "priced_usd"), 8);
    // responder: mini (600k×1 + 400k×0,5 + 500k×2)/1e6 = 1,8 ; caro (100k×10 + 10k×20)/1e6 = 1,2 → 3,0
    const responder = r.by_feature!.find((x) => x.feature === "responder")!;
    expect(Number(responder.priced_usd)).toBeCloseTo(3, 6);
    expect(responder.requests).toBe(2);
    const acordo = r.by_feature!.find((x) => x.feature === "acordo")!;
    expect([acordo.requests, acordo.unpriced, Number(acordo.priced_usd)]).toEqual([1, 1, 0]);
    expect(r.by_feature!.map((x) => x.feature)).toEqual(["responder", "sentiment", "acordo"]); // 3,0 > 0,2002 > 0 (sem preço)
  });

  it("funcionalidade × modelo: ordenado por funcionalidade e valor desc, sem mexer em outra conta nem em outro mês", async () => {
    const r = await report(ACC, "2026-10-01");
    expect(r.by_feature_model!.map((x) => `${x.feature}/${x.sku}`)).toEqual([
      "acordo/openai:sem-tarifa",
      "responder/openai:gpt-4o-mini",
      "responder/openai:caro",
      "sentiment/openai:gpt-4o-mini",
    ]);
    expect((await report(ACC_B, "2026-10-01")).by_feature![0].input_tokens).toBe(9_000_000);
    const sep = await report(ACC, "2026-09-01");
    expect(sep.by_feature!.map((x) => x.feature)).toEqual(["responder"]);
    expect((await report(ACC, "2026-12-01")).by_feature).toEqual([]);
  });

  it("o navegador continua sem acesso à função; service_role chama", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [fn] = (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('${role}', 'wacrm.get_monthly_ai_cost_report(uuid,date)', 'EXECUTE') AS ok`)).rows;
      expect(fn.ok).toBe(false);
    }
    const [svc] = (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', 'wacrm.get_monthly_ai_cost_report(uuid,date)', 'EXECUTE') AS ok`)).rows;
    expect(svc.ok).toBe(true);
  });

  it("idempotente e registra a versão", async () => {
    await db.exec(migration("380_ai_costs_by_feature.sql"));
    expect((await report(ACC, "2026-10-01")).by_feature).toHaveLength(3);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '380_ai_costs_by_feature'`)).rows).toHaveLength(1);
  });

  it("rollback do cabeçalho volta à função da 378 (só 'ai') sem perder dados", async () => {
    await db.exec(headerRollback("380_ai_costs_by_feature.sql"));
    const r = await report(ACC, "2026-10-01");
    expect(Object.keys(r)).toEqual(["ai"]);
    expect(r.ai).toEqual((globalThis as { __before378?: Report }).__before378!.ai);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '380_ai_costs_by_feature'`)).rows).toHaveLength(0);
    expect((await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM wacrm.ai_token_usage`)).rows[0].c).toBe(6);
  });

  it("pré-check: sem a 378 a migration aborta sem alterar nada", async () => {
    const empty = await createRolesDb();
    await expect(empty.exec(migration("380_ai_costs_by_feature.sql"))).rejects.toThrow(/falta wacrm\.get_monthly_ai_cost_report/);
    await empty.close();
  });
});
