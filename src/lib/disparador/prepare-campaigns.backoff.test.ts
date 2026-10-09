// A3: prepareDueCampaigns respeita o backoff (next_prepare_at) e cai no filtro antigo sem a migration 196.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { prepareDueCampaigns } from "./prepare-campaigns";

/* eslint-disable @typescript-eslint/no-explicit-any */
function dueBuilder(results: Array<{ data: unknown; error: { code?: string; message: string } | null }>) {
  const filters: Array<[string, unknown]> = [];
  let call = 0;
  const b: any = {};
  for (const m of ["select", "eq", "lte", "order"]) b[m] = (...a: unknown[]) => (filters.push([m, a]), b);
  b.or = (expr: string) => (filters.push(["or", expr]), b);
  b.limit = () => Promise.resolve(results[Math.min(call++, results.length - 1)]);
  return { db: { from: () => b } as unknown as SupabaseClient, filters, calls: () => call };
}

describe("prepareDueCampaigns — backoff da preparação (A3)", () => {
  it("só pega campanhas cujo next_prepare_at já chegou (ou nulo)", async () => {
    const { db, filters } = dueBuilder([{ data: [], error: null }]);
    await prepareDueCampaigns(db, { outOfTime: () => false, start: vi.fn(), now: new Date("2026-10-08T12:00:00.000Z") });
    expect(filters).toContainEqual(["or", "next_prepare_at.is.null,next_prepare_at.lte.2026-10-08T12:00:00.000Z"]);
  });

  it("sem a migration 196 (coluna ausente): refaz a consulta sem o filtro e segue como antes", async () => {
    const { db, filters, calls } = dueBuilder([
      { data: null, error: { code: "42703", message: "column campaigns.next_prepare_at does not exist" } },
      { data: [{ id: "a", account_id: "acc" }], error: null },
    ]);
    const start = vi.fn(async () => ({ ok: true, enqueued: 1 }) as const);
    const report = await prepareDueCampaigns(db, { outOfTime: () => false, start });
    expect(calls()).toBe(2);
    expect(report.prepared).toBe(1);
    expect(filters.filter(([m]) => m === "or")).toHaveLength(1); // a 2ª consulta não tem o filtro
  });

  it("erro real de leitura continua lançando (não vira 'sem campanhas')", async () => {
    const { db } = dueBuilder([{ data: null, error: { code: "57014", message: "statement timeout" } }]);
    await expect(prepareDueCampaigns(db, { outOfTime: () => false, start: vi.fn() })).rejects.toBeTruthy();
  });
});
