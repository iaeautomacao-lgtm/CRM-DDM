// Migration 378 (custo estimado de IA): tabelas sem acesso do navegador, agregado mensal por tarifa vigente, isolamento por conta,
// idempotência, apply_mfa_policy condicional e rollback do cabeçalho. PGlite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { ACC, ACC_B, createRolesDb, headerRollback, migration } from "@/lib/security/rls-fixture";

type Row = { sku: string; requests: number; input_tokens: number; output_tokens: number; cached_input_tokens: number; priced_usd: number; unpriced: number };

describe("migration 378 — custo de IA", { timeout: 180_000 }, () => {
  let db: PGlite;
  const report = async (acc: string, month: string) =>
    (await db.query<{ r: { ai: Row[] } }>(`SELECT wacrm.get_monthly_ai_cost_report($1::uuid, $2::date) AS r`, [acc, month])).rows[0].r;
  const usage = (acc: string, req: string, model: string, i: number, o: number, c: number, at: string) =>
    db.query(
      `INSERT INTO wacrm.ai_token_usage (account_id, request_id, provider, model, feature, input_tokens, output_tokens, cached_input_tokens, occurred_at) VALUES ($1,$2,'openai',$3,'responder',$4,$5,$6,$7::timestamptz)`,
      [acc, req, model, i, o, c, at],
    );
  const rate = (acc: string, sku: string, from: string, inp: number, out: number, cached: number | null) =>
    db.query(
      `INSERT INTO wacrm.cost_rates (account_id, source, sku, effective_from, currency, input_per_million, cached_input_per_million, output_per_million) VALUES ($1,'ai',$2,$3::date,'USD',$4,$5,$6)`,
      [acc, sku, from, inp, cached, out],
    );

  beforeAll(async () => {
    db = await createRolesDb();
    await db.exec(migration("378_ai_costs.sql"));
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("o navegador (anon/authenticated) não lê nem grava as tabelas nem chama o relatório; service_role sim", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["cost_rates", "ai_token_usage"]) {
        const [sel] = (await db.query<{ ok: boolean }>(`SELECT has_table_privilege('${role}', 'wacrm.${t}', 'SELECT') AS ok`)).rows;
        const [ins] = (await db.query<{ ok: boolean }>(`SELECT has_table_privilege('${role}', 'wacrm.${t}', 'INSERT') AS ok`)).rows;
        expect([sel.ok, ins.ok]).toEqual([false, false]);
      }
      const [fn] = (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('${role}', 'wacrm.get_monthly_ai_cost_report(uuid,date)', 'EXECUTE') AS ok`)).rows;
      expect(fn.ok).toBe(false);
    }
    const [svc] = (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', 'wacrm.get_monthly_ai_cost_report(uuid,date)', 'EXECUTE') AS ok`)).rows;
    expect(svc.ok).toBe(true);
    const rls = await db.query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE oid IN ('wacrm.cost_rates'::regclass, 'wacrm.ai_token_usage'::regclass)`);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    await db.exec("SET ROLE authenticated");
    await expect(db.query(`SELECT * FROM wacrm.ai_token_usage`)).rejects.toThrow(/permission denied/i);
    await db.exec("RESET ROLE");
  });

  it("agrega o mês por provedor:modelo com a tarifa vigente no dia da chamada; sem tarifa = 'sem preço', nunca zero", async () => {
    // tarifa antiga (set) e nova (out/10): a chamada de 05/10 usa a nova; a de 20/09 usa a antiga
    await rate(ACC, "openai:gpt-4o-mini", "2026-01-01", 1, 2, 0.5);
    await rate(ACC, "openai:gpt-4o-mini", "2026-10-01", 10, 20, 5);
    await usage(ACC, "r1", "gpt-4o-mini", 1_000_000, 500_000, 400_000, "2026-10-05T12:00:00Z");
    await usage(ACC, "r2", "gpt-4o-mini", 1_000_000, 0, 0, "2026-09-20T12:00:00Z");
    await usage(ACC, "r3", "modelo-sem-tarifa", 1000, 10, 0, "2026-10-06T12:00:00Z");
    await usage(ACC_B, "rb", "gpt-4o-mini", 9_000_000, 9_000_000, 0, "2026-10-05T12:00:00Z");

    const out = await report(ACC, "2026-10-01");
    const mini = out.ai.find((r) => r.sku === "openai:gpt-4o-mini")!;
    // (1.000.000-400.000)×10/1e6 + 400.000×5/1e6 + 500.000×20/1e6 = 6 + 2 + 10 = 18
    expect(Number(mini.priced_usd)).toBeCloseTo(18, 6);
    expect([mini.requests, mini.unpriced]).toEqual([1, 0]);
    const semTarifa = out.ai.find((r) => r.sku === "openai:modelo-sem-tarifa")!;
    expect([semTarifa.requests, semTarifa.unpriced, Number(semTarifa.priced_usd)]).toEqual([1, 1, 0]);

    const sep = (await report(ACC, "2026-09-01")).ai[0];
    expect(Number(sep.priced_usd)).toBeCloseTo(1, 6); // 1.000.000 × 1 / 1e6, tarifa antiga
  });

  it("isola por conta e respeita a virada do mês em America/Sao_Paulo", async () => {
    expect((await report(ACC_B, "2026-10-01")).ai[0].input_tokens).toBe(9_000_000);
    // 01/11 02:00 UTC = 31/10 23:00 em São Paulo: ainda é outubro
    await usage(ACC, "borda", "gpt-4o-mini", 100, 1, 0, "2026-11-01T02:00:00Z");
    const oct = (await report(ACC, "2026-10-01")).ai.find((r) => r.sku === "openai:gpt-4o-mini")!;
    expect(oct.requests).toBe(2);
    expect((await report(ACC, "2026-11-01")).ai).toEqual([]);
    expect((await report("00000000-0000-0000-0000-0000000000ff", "2026-10-01")).ai).toEqual([]);
  });

  it("não duplica por (conta, provedor, request_id) e valida contagens", async () => {
    await expect(usage(ACC, "r1", "gpt-4o-mini", 1, 1, 0, "2026-10-05T12:00:00Z")).rejects.toThrow(/duplicate|unique/i);
    await expect(usage(ACC, "neg", "gpt-4o-mini", 10, 1, 11, "2026-10-05T12:00:00Z")).rejects.toThrow(/check/i); // cache > entrada
    await expect(rate(ACC, "openai:x", "2026-10-01", -1, 2, null)).rejects.toThrow(/check/i);
  });

  it("idempotente (reaplicar não perde dados) e registra a versão", async () => {
    await db.exec(migration("378_ai_costs.sql"));
    expect((await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM wacrm.ai_token_usage`)).rows[0].c).toBeGreaterThan(0);
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '378_ai_costs'`)).rows).toHaveLength(1);
  });

  it("não cria meta_deliveries_cost nem mexe em ingest_status_events (custo Meta é da 195)", () => {
    const sql = migration("378_ai_costs.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/meta_deliveries_cost|ingest_status_events/);
  });

  it("rollback do cabeçalho remove o que a migration criou", async () => {
    await db.exec(headerRollback("378_ai_costs.sql"));
    const left = await db.query(`SELECT to_regclass('wacrm.ai_token_usage') AS a, to_regclass('wacrm.cost_rates') AS c, to_regprocedure('wacrm.get_monthly_ai_cost_report(uuid,date)') AS f`);
    expect(left.rows[0]).toEqual({ a: null, c: null, f: null });
  });
});

describe("migration 378 — apply_mfa_policy condicional", { timeout: 180_000 }, () => {
  it("com a 310 aplicada, as duas tabelas ganham mfa_aal2_required; sem ela, a migration roda do mesmo jeito", async () => {
    const without = await createRolesDb();
    await without.exec(migration("378_ai_costs.sql")); // sem apply_mfa_policy: não quebra
    await without.close();

    const withMfa = await createRolesDb();
    await withMfa.exec(`
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
      CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, factor_type text NOT NULL, status text NOT NULL);
    `);
    await withMfa.exec(migration("310_rls_mfa_aal2.sql"));
    await withMfa.exec(migration("378_ai_costs.sql"));
    const pol = await withMfa.query<{ tablename: string }>(`SELECT tablename FROM pg_policies WHERE schemaname = 'wacrm' AND policyname = 'mfa_aal2_required' AND tablename IN ('cost_rates', 'ai_token_usage')`);
    expect(pol.rows.map((r) => r.tablename).sort()).toEqual(["ai_token_usage", "cost_rates"]);
    await withMfa.close();
  });
});
