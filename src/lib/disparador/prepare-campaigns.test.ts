import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPrepareInTickEnabled, prepareDueCampaigns, recoverStuckPreparing } from "./prepare-campaigns";

type Filter = [string, string, unknown];

// Banco falso: registra o UPDATE (valores + filtros) e devolve linhas por variante.
function fakeDb(options: {
  due?: Array<{ id: string; account_id: string | null }>;
  withSchedule?: number;
  withoutSchedule?: number;
}) {
  const updates: Array<{ values: Record<string, unknown>; filters: Filter[] }> = [];
  const db = {
    from: () => {
      const filters: Filter[] = [];
      let values: Record<string, unknown> | null = null;
      const b: Record<string, any> = {};
      b.update = (v: Record<string, unknown>) => ((values = v), b);
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (filters.push(["eq", c, v]), b);
      b.lt = (c: string, v: unknown) => (filters.push(["lt", c, v]), b);
      b.lte = (c: string, v: unknown) => (filters.push(["lte", c, v]), b);
      b.not = (c: string, op: string, v: unknown) => (filters.push(["not", c, `${op}:${String(v)}`]), b);
      b.is = (c: string, v: unknown) => (filters.push(["is", c, v]), b);
      b.or = (expr: string) => (filters.push(["or", "", expr]), b);
      b.or = (expr: string) => (filters.push(["or", "", expr]), b);
      b.order = () => b;
      b.limit = () => b;
      b.then = (resolve: (v: unknown) => unknown) => {
        if (values) {
          updates.push({ values, filters });
          const scheduled = filters.some((f) => f[0] === "not" && f[1] === "agendamento");
          const n = scheduled ? (options.withSchedule ?? 0) : (options.withoutSchedule ?? 0);
          return Promise.resolve({
            data: Array.from({ length: n }, (_, i) => ({ id: `x${i}` })),
            error: null,
          }).then(resolve);
        }
        return Promise.resolve({ data: options.due ?? [], error: null }).then(resolve);
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

describe("isPrepareInTickEnabled", () => {
  it("padrão true; false/0/off/no desligam", () => {
    const env = (v?: string) => (v === undefined ? {} : { DISPARADOR_PREPARE_IN_TICK: v }) as unknown as NodeJS.ProcessEnv;
    expect(isPrepareInTickEnabled(env())).toBe(true);
    expect(isPrepareInTickEnabled(env("true"))).toBe(true);
    for (const v of ["false", "FALSE", "0", "off", "no"]) expect(isPrepareInTickEnabled(env(v))).toBe(false);
  });
});

describe("recoverStuckPreparing", () => {
  it("presa há mais de 30 min: COM agendamento → agendado; SEM → rascunho", async () => {
    const { db, updates } = fakeDb({ withSchedule: 2, withoutSchedule: 1 });
    const r = await recoverStuckPreparing(db, new Date("2026-10-08T12:00:00Z"));
    expect(r).toEqual({ toAgendado: 2, toRascunho: 1 });
    expect(updates).toHaveLength(2);
    const [withSchedule, withoutSchedule] = updates;
    expect(withSchedule.values.status).toBe("agendado");
    expect(withSchedule.filters).toContainEqual(["eq", "status", "preparando"]);
    expect(withSchedule.filters).toContainEqual(["lt", "updated_at", "2026-10-08T11:30:00.000Z"]);
    expect(withSchedule.filters).toContainEqual(["not", "agendamento", "is:null"]);
    expect(withoutSchedule.values.status).toBe("rascunho");
    expect(withoutSchedule.filters).toContainEqual(["is", "agendamento", null]);
  });
});

describe("prepareDueCampaigns", () => {
  const due = [
    { id: "a", account_id: "acc" },
    { id: "b", account_id: "acc" },
    { id: "c", account_id: null },
    { id: "d", account_id: "acc" },
  ];

  it("prepara uma por vez, em sequência, e ignora campanha sem conta", async () => {
    const { db } = fakeDb({ due });
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const start = vi.fn(async (id: string) => {
      running++;
      peak = Math.max(peak, running);
      order.push(id);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      return id === "b" ? ({ ok: false, status: 500, error: "x" } as const) : ({ ok: true, enqueued: 10 } as const);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const report = await prepareDueCampaigns(db, { outOfTime: () => false, start });
    expect(order).toEqual(["a", "b", "d"]);
    expect(peak).toBe(1);
    expect(report).toMatchObject({ attempted: 3, prepared: 2, failed: 1 });
  });

  it("orçamento de tempo: para antes de começar a próxima", async () => {
    const { db } = fakeDb({ due });
    let checks = 0;
    const start = vi.fn(async () => ({ ok: true, enqueued: 1 }) as const);
    const report = await prepareDueCampaigns(db, { outOfTime: () => checks++ >= 1, start });
    expect(start).toHaveBeenCalledTimes(1);
    expect(report.attempted).toBe(1);
  });
});
