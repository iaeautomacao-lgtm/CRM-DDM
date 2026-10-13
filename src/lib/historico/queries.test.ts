import { describe, expect, it } from "vitest";
import { loadClosedConversations } from "./queries";

// Construtor de consulta falso: registra as chamadas encadeadas e resolve com `data` ao ser aguardado.
function fakeDb() {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lte", "in", "order", "range", "or", "limit"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder.from = (table: string) => {
    calls.push(["from", [table]]);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return { db: builder as never, calls };
}

const base = { accountId: "acc", period: "todas" as const, search: "", page: 0 };

describe("loadClosedConversations", () => {
  it("padrão: só encerradas, ordenadas e filtradas por closed_at", async () => {
    const { db, calls } = fakeDb();
    await loadClosedConversations(db, { ...base, period: "7d" });
    expect(calls).toContainEqual(["eq", ["status", "closed"]]);
    expect(calls).toContainEqual(["order", ["closed_at", { ascending: false, nullsFirst: false }]]);
    expect(calls.some(([m, a]) => m === "gte" && a[0] === "closed_at")).toBe(true);
  });

  it("em andamento: status open e created_at", async () => {
    const { db, calls } = fakeDb();
    await loadClosedConversations(db, { ...base, period: "30d", status: "open" });
    expect(calls).toContainEqual(["eq", ["status", "open"]]);
    expect(calls.some(([m, a]) => m === "gte" && a[0] === "created_at")).toBe(true);
  });

  it("todas: sem filtro de status", async () => {
    const { db, calls } = fakeDb();
    await loadClosedConversations(db, { ...base, status: "all" });
    expect(calls.some(([m, a]) => m === "eq" && a[0] === "status")).toBe(false);
  });

  it("período personalizado vale no lugar do período rápido, com as duas pontas", async () => {
    const { db, calls } = fakeDb();
    await loadClosedConversations(db, { ...base, period: "hoje", range: { from: "2026-10-01", to: "2026-10-10" } });
    expect(calls.filter(([m]) => m === "gte")).toHaveLength(1);
    expect(calls.filter(([m]) => m === "lte")).toHaveLength(1);
  });

  it("período personalizado com só uma ponta", async () => {
    const { db, calls } = fakeDb();
    await loadClosedConversations(db, { ...base, range: { from: "2026-10-01", to: "" } });
    expect(calls.filter(([m]) => m === "gte")).toHaveLength(1);
    expect(calls.filter(([m]) => m === "lte")).toHaveLength(0);
  });
});
