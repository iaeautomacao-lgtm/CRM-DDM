// F14: quem envia renova o lease enquanto espera a Meta; para no fim; sem a coluna se desliga sozinho.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INFLIGHT_LEASE_SECONDS, resetInflightLeaseState, startInflightLease } from "./inflight-lease";

function fakeDb(error: { code?: string; message: string } | null = null) {
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const db = {
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const chain: any = {
          eq: (c: string, v: unknown) => (filters.push([c, v]), chain),
          then: (resolve: (v: unknown) => void) => (updates.push({ values, filters }), resolve({ error })),
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { db, updates };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  resetInflightLeaseState();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("startInflightLease", () => {
  it("envio rápido (< 30 s): não escreve nada no banco", async () => {
    const { db, updates } = fakeDb();
    const lease = startInflightLease(db, "item-1");
    await vi.advanceTimersByTimeAsync(5_000);
    lease.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updates).toHaveLength(0);
  });

  it("espera lenta pela Meta: renova a cada 30 s, só o item enviando, com lease de 120 s", async () => {
    const { db, updates } = fakeDb();
    const lease = startInflightLease(db, "item-1");
    await vi.advanceTimersByTimeAsync(65_000); // 2 renovações (30 s e 60 s)
    expect(updates).toHaveLength(2);
    expect(updates[1].filters).toEqual([["id", "item-1"], ["status", "enviando"]]);
    const until = Date.parse(String(updates[1].values.inflight_until));
    expect(until - Date.now()).toBeGreaterThan((INFLIGHT_LEASE_SECONDS - 10) * 1000);
    expect(until - Date.now()).toBeLessThanOrEqual(INFLIGHT_LEASE_SECONDS * 1000);
    lease.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updates).toHaveLength(2); // parou
  });

  it("sem a coluna (migration 194 ausente): desliga a renovação para sempre, sem barulho", async () => {
    const { db, updates } = fakeDb({ code: "42703", message: "column inflight_until does not exist" });
    const lease = startInflightLease(db, "item-1");
    await vi.advanceTimersByTimeAsync(95_000);
    expect(updates).toHaveLength(1); // 1ª tentativa descobre; as seguintes não insistem
    lease.stop();
    expect(startInflightLease(db, "item-2").stop).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(95_000);
    expect(updates).toHaveLength(1);
  });

  it("falha qualquer ao renovar não lança nem derruba o envio", async () => {
    const { db } = fakeDb({ code: "57014", message: "statement timeout" });
    const lease = startInflightLease(db, "item-1");
    await expect(vi.advanceTimersByTimeAsync(31_000)).resolves.not.toThrow();
    lease.stop();
  });
});
