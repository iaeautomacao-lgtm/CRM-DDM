// Mini Supabase em memória só para testes: from(t).select/insert/upsert/update + eq/is/in/gte/order/limit, thenable.
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
export type FakeTables = Record<string, Row[]>;

export function fakeDb(tables: FakeTables, missing: string[] = []) {
  const inserts: Array<{ table: string; row: Row }> = [];
  const db = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "upsert" | "insert" = "select";
      let payload: Row | Row[] = {};
      let onConflict = "";
      let max = Infinity;
      const run = () => {
        if (missing.includes(table)) return { data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } };
        const rows = (tables[table] ??= []);
        if (op === "insert") {
          for (const r of Array.isArray(payload) ? payload : [payload]) {
            rows.push({ ...r });
            inserts.push({ table, row: r });
          }
          return { data: null, error: null };
        }
        if (op === "upsert") {
          const r = payload as Row;
          const hit = rows.find((x) => x[onConflict] === r[onConflict]);
          if (hit) Object.assign(hit, r);
          else rows.push({ ...r });
          return { data: null, error: null };
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of matched) Object.assign(r, payload);
          return { data: matched.map((r) => ({ ...r })), error: null };
        }
        return { data: matched.slice(0, max).map((r) => ({ ...r })), error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (p: Row | Row[]) => {
          op = "insert";
          payload = p;
          return q;
        },
        upsert: (p: Row, o?: { onConflict?: string }) => {
          op = "upsert";
          payload = p;
          onConflict = o?.onConflict ?? "id";
          return q;
        },
        update: (p: Row) => {
          op = "update";
          payload = p;
          return q;
        },
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
        gte: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "") >= v), q),
        order: () => q,
        limit: (n: number) => {
          max = n;
          return q;
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return q;
    },
  };
  return { db: db as unknown as Pick<SupabaseClient, "from">, inserts, tables };
}
