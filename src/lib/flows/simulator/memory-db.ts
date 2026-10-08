import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Banco em memória do simulador de fluxo (PRD 05).
 *
 * Implementa só o pedaço do query builder do PostgREST que o motor
 * (engine.ts) e a IA simulada usam: select/insert/update/upsert/delete,
 * eq/neq/in/is/gt/gte/lt/lte/filter, order/limit/range, maybeSingle/single,
 * count/head e rpc. Nada sai do processo — é isso que garante que o
 * simulador não grava em tabela real nenhuma.
 *
 * As linhas vivem em `tables` (JSON puro): o servidor é stateless
 * (Passenger reinicia), então o cliente devolve o estado a cada mensagem.
 */

export type SimRow = Record<string, unknown>;
export type SimTables = Record<string, SimRow[]>;

/** Relógio monotônico — duas linhas nunca ganham o mesmo timestamp. */
export interface SimClock {
  last: number;
}

export function simNow(clock: SimClock): string {
  clock.last = Math.max(Date.now(), clock.last + 1);
  return new Date(clock.last).toISOString();
}

export type SimRpcHandler = (args: Record<string, unknown>, tables: SimTables, clock: SimClock) => unknown;

export interface MemoryDbOptions {
  tables: SimTables;
  clock: SimClock;
  rpc?: Record<string, SimRpcHandler>;
  /** Valores padrão por tabela no INSERT (como os DEFAULT do Postgres). */
  defaults?: Record<string, (clock: SimClock) => SimRow>;
}

type DbResult = { data: unknown; error: { message: string; code?: string } | null; count: number | null };

/** Lê `col` ou caminho JSON `payload->>chave` / `payload->chave`. */
function readColumn(row: SimRow, col: string): unknown {
  if (!col.includes("->")) return row[col];
  const parts = col.split(/->>?/);
  let value: unknown = row[parts[0]];
  for (const key of parts.slice(1)) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  if (col.includes("->>") && value !== undefined && value !== null && typeof value !== "string") {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return value;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

type Filter = (row: SimRow) => boolean;

function opFilter(col: string, op: string, value: unknown): Filter {
  return (row) => {
    const v = readColumn(row, col);
    switch (op) {
      case "eq":
        return v !== null && v !== undefined && v === value;
      case "neq":
        return v !== null && v !== undefined && v !== value;
      case "gt":
        return v !== null && v !== undefined && compare(v, value) > 0;
      case "gte":
        return v !== null && v !== undefined && compare(v, value) >= 0;
      case "lt":
        return v !== null && v !== undefined && compare(v, value) < 0;
      case "lte":
        return v !== null && v !== undefined && compare(v, value) <= 0;
      case "is":
        return value === null ? v === null || v === undefined : v === value;
      default:
        throw new Error(`memory-db: operador não suportado: ${op}`);
    }
  };
}

function project(row: SimRow, columns: string | null): SimRow {
  const copy = JSON.parse(JSON.stringify(row)) as SimRow;
  if (!columns || columns.trim() === "*") return copy;
  const out: SimRow = {};
  for (const raw of columns.split(",")) {
    const col = raw.trim();
    if (!col) continue;
    if (/[(!:]/.test(col)) throw new Error(`memory-db: select com relacionamento não suportado: ${col}`);
    out[col] = copy[col] ?? null;
  }
  return out;
}

class MemoryQuery implements PromiseLike<DbResult> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: Filter[] = [];
  private orders: Array<{ col: string; ascending: boolean }> = [];
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private singleMode: "maybe" | "single" | null = null;
  private columns: string | null = "*";
  private returning = false;
  private countMode = false;
  private head = false;
  private payload: SimRow[] = [];
  private patch: SimRow = {};
  private onConflict: string[] = [];

  constructor(
    private readonly table: string,
    private readonly opts: MemoryDbOptions,
  ) {}

  select(columns = "*", options?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.columns = columns;
    } else {
      this.returning = true;
      this.columns = columns;
    }
    if (options?.count) this.countMode = true;
    if (options?.head) this.head = true;
    return this;
  }
  insert(values: SimRow | SimRow[]) {
    this.op = "insert";
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }
  upsert(values: SimRow | SimRow[], options?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = Array.isArray(values) ? values : [values];
    this.onConflict = (options?.onConflict ?? "id").split(",").map((c) => c.trim());
    return this;
  }
  update(patch: SimRow) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push(opFilter(col, "eq", value));
    return this;
  }
  neq(col: string, value: unknown) {
    this.filters.push(opFilter(col, "neq", value));
    return this;
  }
  gt(col: string, value: unknown) {
    this.filters.push(opFilter(col, "gt", value));
    return this;
  }
  gte(col: string, value: unknown) {
    this.filters.push(opFilter(col, "gte", value));
    return this;
  }
  lt(col: string, value: unknown) {
    this.filters.push(opFilter(col, "lt", value));
    return this;
  }
  lte(col: string, value: unknown) {
    this.filters.push(opFilter(col, "lte", value));
    return this;
  }
  is(col: string, value: unknown) {
    this.filters.push(opFilter(col, "is", value));
    return this;
  }
  in(col: string, values: unknown[]) {
    this.filters.push((row) => values.includes(readColumn(row, col)));
    return this;
  }
  filter(col: string, op: string, value: unknown) {
    this.filters.push(opFilter(col, op, value));
    return this;
  }
  order(col: string, options?: { ascending?: boolean }) {
    this.orders.push({ col, ascending: options?.ascending ?? true });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybe";
    return this;
  }
  single() {
    this.singleMode = "single";
    return this;
  }

  then<TResult1 = DbResult, TResult2 = never>(
    onfulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    let result: DbResult;
    try {
      result = this.execute();
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected);
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }

  private rows(): SimRow[] {
    const tables = this.opts.tables;
    if (!tables[this.table]) tables[this.table] = [];
    return tables[this.table];
  }

  private matching(): SimRow[] {
    return this.rows().filter((row) => this.filters.every((f) => f(row)));
  }

  private shape(rows: SimRow[]): DbResult {
    let out = [...rows];
    for (const { col, ascending } of [...this.orders].reverse()) {
      out.sort((a, b) => {
        const av = readColumn(a, col);
        const bv = readColumn(b, col);
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return ascending ? compare(av, bv) : compare(bv, av);
      });
    }
    const count = out.length;
    if (this.rangeFrom !== null && this.rangeTo !== null) out = out.slice(this.rangeFrom, this.rangeTo + 1);
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    const data = out.map((row) => project(row, this.columns));
    if (this.head) return { data: null, error: null, count };
    if (this.singleMode) {
      if (data.length > 1) {
        return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, count: null };
      }
      if (data.length === 0 && this.singleMode === "single") {
        return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, count: null };
      }
      return { data: data[0] ?? null, error: null, count: this.countMode ? count : null };
    }
    return { data, error: null, count: this.countMode ? count : null };
  }

  private newRow(values: SimRow): SimRow {
    const clock = this.opts.clock;
    const now = simNow(clock);
    const defaults = this.opts.defaults?.[this.table]?.(clock) ?? {};
    return { id: randomUUID(), created_at: now, ...defaults, ...JSON.parse(JSON.stringify(values)) };
  }

  private violatesUnique(row: SimRow): boolean {
    // idx_one_active_run_per_contact (migrations 017/115).
    if (this.table !== "flow_runs") return false;
    if (row.status !== "active" && row.status !== "paused_by_agent") return false;
    return this.rows().some(
      (r) =>
        r.account_id === row.account_id &&
        r.contact_id === row.contact_id &&
        (r.status === "active" || r.status === "paused_by_agent"),
    );
  }

  private execute(): DbResult {
    if (this.op === "select") return this.shape(this.matching());

    if (this.op === "insert") {
      const inserted: SimRow[] = [];
      for (const values of this.payload) {
        const row = this.newRow(values);
        if (this.violatesUnique(row)) {
          return {
            data: null,
            error: { message: 'duplicate key value violates unique constraint "idx_one_active_run_per_contact" (23505)', code: "23505" },
            count: null,
          };
        }
        this.rows().push(row);
        inserted.push(row);
      }
      return this.returning ? this.shape(inserted) : { data: null, error: null, count: null };
    }

    if (this.op === "upsert") {
      const touched: SimRow[] = [];
      for (const values of this.payload) {
        const existing = this.rows().find((r) => this.onConflict.every((c) => r[c] === values[c]));
        if (existing) {
          Object.assign(existing, JSON.parse(JSON.stringify(values)));
          touched.push(existing);
        } else {
          const row = this.newRow(values);
          this.rows().push(row);
          touched.push(row);
        }
      }
      return this.returning ? this.shape(touched) : { data: null, error: null, count: null };
    }

    if (this.op === "update") {
      const hit = this.matching();
      for (const row of hit) Object.assign(row, JSON.parse(JSON.stringify(this.patch)));
      return this.returning ? this.shape(hit) : { data: null, error: null, count: null };
    }

    // delete
    const hit = this.matching();
    this.opts.tables[this.table] = this.rows().filter((row) => !hit.includes(row));
    return this.returning ? this.shape(hit) : { data: null, error: null, count: null };
  }
}

/** Cliente com a cara do SupabaseClient, inteiro em memória. */
export function createMemoryDb(opts: MemoryDbOptions): SupabaseClient {
  const client = {
    from: (table: string) => new MemoryQuery(table, opts),
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      const handler = opts.rpc?.[name];
      if (!handler) {
        return { data: null, error: { message: `memory-db: rpc ${name} não simulada` }, count: null };
      }
      return { data: handler(args, opts.tables, opts.clock), error: null, count: null };
    },
    storage: {
      from: () => {
        throw new Error("memory-db: storage não disponível no simulador");
      },
    },
  };
  return client as unknown as SupabaseClient;
}
