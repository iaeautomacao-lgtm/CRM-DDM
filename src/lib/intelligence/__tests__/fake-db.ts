// Banco falso em memória para os testes do Intelligence: imita o builder
// do PostgREST (thenable) e aplica de verdade os filtros que data.ts usa
// (eq, neq, in, gte, lt, not in, limit, range). `.or()` é ignorado (devolve
// o superconjunto — os módulos de cálculo filtram o período de novo).
// `.select()` não projeta colunas: a linha volta inteira.

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

export interface QueryLog {
  table: string;
  calls: Array<[string, ...unknown[]]>;
}

function cmp(a: unknown, b: unknown): number {
  return String(a ?? "").localeCompare(String(b ?? ""));
}

export function fakeDb(tables: Tables): { db: SupabaseClient; log: QueryLog[] } {
  const log: QueryLog[] = [];

  function from(table: string) {
    const rec: QueryLog = { table, calls: [] };
    log.push(rec);
    let rows = [...(tables[table] ?? [])];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    const orders: Array<{ col: string; asc: boolean }> = [];

    const builder: Record<string, unknown> = {};
    const chain = (name: string, fn: (...args: unknown[]) => void) => {
      builder[name] = (...args: unknown[]) => {
        rec.calls.push([name, ...args]);
        fn(...args);
        return builder;
      };
    };
    chain("select", () => {});
    chain("or", () => {});
    chain("eq", (c, v) => (rows = rows.filter((r) => r[c as string] === v)));
    chain("neq", (c, v) => (rows = rows.filter((r) => r[c as string] !== v)));
    chain("in", (c, vs) => (rows = rows.filter((r) => (vs as unknown[]).includes(r[c as string]))));
    chain("gte", (c, v) => (rows = rows.filter((r) => cmp(r[c as string], v) >= 0)));
    chain("lt", (c, v) => (rows = rows.filter((r) => r[c as string] !== null && cmp(r[c as string], v) < 0)));
    chain("not", (c, op, v) => {
      if (op === "in") {
        const list = String(v).replace(/^\(|\)$/g, "").split(",");
        rows = rows.filter((r) => !list.includes(String(r[c as string])));
      }
    });
    chain("order", (c, opts) => orders.push({ col: c as string, asc: (opts as { ascending?: boolean } | undefined)?.ascending ?? true }));
    chain("range", (a, b) => (range = [a as number, b as number]));
    chain("limit", (n) => (limit = n as number));
    builder.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try {
        let out = [...rows];
        if (orders.length) {
          out.sort((x, y) => {
            for (const o of orders) {
              const d = cmp(x[o.col], y[o.col]);
              if (d !== 0) return o.asc ? d : -d;
            }
            return 0;
          });
        }
        const total = out.length;
        if (range) out = out.slice(range[0], range[1] + 1);
        if (limit !== null) out = out.slice(0, limit);
        resolve({ data: out, error: null, count: total });
      } catch (e) {
        reject(e);
      }
    };
    return builder;
  }

  return { db: { from } as unknown as SupabaseClient, log };
}
