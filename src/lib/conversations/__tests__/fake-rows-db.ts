// Banco falso em memória (tabulação): imita o builder do PostgREST
// (thenable) com select/update/insert e os filtros usados pelos módulos de
// tabulação (eq, neq, is, in, order, limit, maybeSingle). UPDATEs são
// aplicados de verdade nas linhas, para os testes conferirem o estado
// final. `.select()` não projeta colunas.

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

export interface OpLog {
  table: string;
  type: "select" | "update" | "insert";
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

export function fakeRowsDb(tables: Tables): { db: SupabaseClient; log: OpLog[]; tables: Tables } {
  const log: OpLog[] = [];

  function from(table: string) {
    tables[table] ??= [];
    const op: OpLog = { table, type: "select", filters: [] };
    log.push(op);
    const preds: Array<(r: Row) => boolean> = [];
    let limit: number | null = null;
    let single = false;
    const orders: Array<{ col: string; asc: boolean }> = [];

    const builder: Record<string, unknown> = {};
    const chain = (name: string, fn: (...args: unknown[]) => void) => {
      builder[name] = (...args: unknown[]) => {
        if (!["select", "update", "insert"].includes(name)) op.filters.push([name, ...args]);
        fn(...args);
        return builder;
      };
    };
    chain("select", () => {});
    chain("update", (p) => {
      op.type = "update";
      op.payload = p;
    });
    chain("insert", (p) => {
      op.type = "insert";
      op.payload = p;
    });
    chain("eq", (c, v) => preds.push((r) => r[c as string] === v));
    chain("neq", (c, v) => preds.push((r) => r[c as string] !== v));
    chain("is", (c, v) => preds.push((r) => (r[c as string] ?? null) === v));
    chain("in", (c, vs) => preds.push((r) => (vs as unknown[]).includes(r[c as string])));
    chain("order", (c, o) =>
      orders.push({ col: c as string, asc: (o as { ascending?: boolean } | undefined)?.ascending ?? true }),
    );
    chain("limit", (n) => (limit = n as number));
    chain("maybeSingle", () => (single = true));

    builder.then = (resolve: (v: unknown) => void) => {
      const rows = tables[table];
      if (op.type === "insert") {
        const items = Array.isArray(op.payload) ? op.payload : [op.payload];
        rows.push(...(items as Row[]));
        return resolve({ data: null, error: null });
      }
      let out = rows.filter((r) => preds.every((p) => p(r)));
      if (op.type === "update") {
        for (const r of out) Object.assign(r, op.payload as Row);
      }
      if (orders.length) {
        out = [...out].sort((x, y) => {
          for (const o of orders) {
            const d = String(x[o.col] ?? "").localeCompare(String(y[o.col] ?? ""));
            if (d !== 0) return o.asc ? d : -d;
          }
          return 0;
        });
      }
      if (limit !== null) out = out.slice(0, limit);
      if (single) return resolve({ data: out[0] ?? null, error: null });
      resolve({ data: out, error: null });
    };
    return builder;
  }

  return { db: { from } as unknown as SupabaseClient, log, tables };
}
