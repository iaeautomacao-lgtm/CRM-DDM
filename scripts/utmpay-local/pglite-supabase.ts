// Adaptador mínimo "supabase-js sobre PGlite" para o teste local UTMpay ↔ CRM. Implementa SÓ o subconjunto do PostgREST que as libs do UTMpay
// usam (from/select/insert/update/upsert/eq/in/is/not/gt/lte/or/order/limit/maybeSingle e rpc), traduzindo para SQL no schema `wacrm`.
// Serve para rodar o código REAL do CRM (client.ts, links.ts, ingest.ts, rota de eventos…) sem Supabase remoto. Não é um cliente completo.
import type { PGlite } from "@electric-sql/pglite";

type Where = { sql: (next: () => string) => string; params: unknown[] };
interface Result<T = unknown> {
  data: T | null;
  error: { code?: string; message: string } | null;
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`identificador inválido: ${name}`);
  return `"${name}"`;
};

/** Como o PostgREST devolve: datas em ISO, resto como veio. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private cols = "*";
  private wheres: Where[] = [];
  private orderBy: string[] = [];
  private limitN: number | null = null;
  private payload: Record<string, unknown>[] = [];
  private onConflict: string | null = null;
  private ignoreDuplicates = false;
  private single = false;

  constructor(
    private readonly db: PGlite,
    private readonly table: string,
  ) {}

  select(cols = "*") {
    if (this.op === "select") this.cols = cols;
    return this;
  }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(values: Record<string, unknown>) {
    this.op = "update";
    this.payload = [values];
    return this;
  }
  upsert(rows: Record<string, unknown> | Record<string, unknown>[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = opts.onConflict ?? null;
    this.ignoreDuplicates = opts.ignoreDuplicates === true;
    return this;
  }

  private add(sql: (col: string, p: string) => string, col: string, value: unknown) {
    this.wheres.push({ sql: (next) => sql(ident(col), next()), params: [value] });
    return this;
  }
  eq(col: string, value: unknown) {
    return this.add((c, p) => `${c} = ${p}`, col, value);
  }
  gt(col: string, value: unknown) {
    return this.add((c, p) => `${c} > ${p}`, col, value);
  }
  gte(col: string, value: unknown) {
    return this.add((c, p) => `${c} >= ${p}`, col, value);
  }
  lt(col: string, value: unknown) {
    return this.add((c, p) => `${c} < ${p}`, col, value);
  }
  lte(col: string, value: unknown) {
    return this.add((c, p) => `${c} <= ${p}`, col, value);
  }
  in(col: string, values: unknown[]) {
    this.wheres.push({ sql: (next) => `${ident(col)}::text = ANY(${next()}::text[])`, params: [values.map(String)] });
    return this;
  }
  is(col: string, value: null) {
    void value;
    this.wheres.push({ sql: () => `${ident(col)} IS NULL`, params: [] });
    return this;
  }
  not(col: string, op: string, value: null) {
    if (op !== "is" || value !== null) throw new Error("adaptador: not() só suporta ('col','is',null)");
    this.wheres.push({ sql: () => `${ident(col)} IS NOT NULL`, params: [] });
    return this;
  }
  /** `col.is.null,col.gt.<valor>` (o formato que o ingest usa). */
  or(filter: string) {
    const parts = filter.split(",").map((part) => {
      const [col, op, ...rest] = part.split(".");
      return { col, op, value: rest.join(".") };
    });
    const params: unknown[] = [];
    const pieces: Array<(next: () => string) => string> = [];
    for (const { col, op, value } of parts) {
      if (op === "is" && value === "null") pieces.push(() => `${ident(col)} IS NULL`);
      else if (op === "gt" || op === "lt" || op === "eq") {
        params.push(value);
        const sym = op === "gt" ? ">" : op === "lt" ? "<" : "=";
        pieces.push((next) => `${ident(col)} ${sym} ${next()}`);
      } else throw new Error(`adaptador: or() não suporta "${col}.${op}.${value}"`);
    }
    this.wheres.push({ sql: (next) => `(${pieces.map((p) => p(next)).join(" OR ")})`, params });
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy.push(`${ident(col)} ${opts.ascending === false ? "DESC" : "ASC"}`);
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  async maybeSingle(): Promise<Result> {
    this.single = true;
    this.limitN = 1;
    return this.run();
  }

  private buildWhere(startAt: number): { sql: string; params: unknown[] } {
    let i = startAt;
    const params: unknown[] = [];
    const parts: string[] = [];
    for (const w of this.wheres) {
      parts.push(w.sql(() => `$${++i}`));
      params.push(...w.params);
    }
    return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
  }

  private async run(): Promise<Result> {
    const table = `wacrm.${ident(this.table)}`;
    try {
      if (this.op === "select") {
        const where = this.buildWhere(0);
        const cols = this.cols === "*" ? "*" : this.cols.split(",").map((c) => ident(c.trim())).join(", ");
        const sql = `SELECT ${cols} FROM ${table}${where.sql}${this.orderBy.length ? ` ORDER BY ${this.orderBy.join(", ")}` : ""}${this.limitN !== null ? ` LIMIT ${this.limitN}` : ""}`;
        const res = await this.db.query<Record<string, unknown>>(sql, where.params);
        const rows = res.rows.map(normalizeRow);
        return { data: this.single ? (rows[0] ?? null) : rows, error: null };
      }
      if (this.op === "update") {
        const entries = Object.entries(this.payload[0]);
        const sets = entries.map(([k], i) => `${ident(k)} = $${i + 1}`);
        const where = this.buildWhere(entries.length);
        await this.db.query(`UPDATE ${table} SET ${sets.join(", ")}${where.sql}`, [...entries.map(([, v]) => v), ...where.params]);
        return { data: null, error: null };
      }
      // insert / upsert
      const columns = Object.keys(this.payload[0]);
      const params: unknown[] = [];
      const tuples = this.payload.map((row) => `(${columns.map((c) => (params.push(row[c]), `$${params.length}`)).join(", ")})`);
      let sql = `INSERT INTO ${table} (${columns.map(ident).join(", ")}) VALUES ${tuples.join(", ")}`;
      if (this.op === "upsert") {
        if (!this.onConflict) throw new Error("adaptador: upsert exige onConflict");
        sql += this.ignoreDuplicates
          ? ` ON CONFLICT (${ident(this.onConflict)}) DO NOTHING`
          : ` ON CONFLICT (${ident(this.onConflict)}) DO UPDATE SET ${columns.filter((c) => c !== this.onConflict).map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(", ")}`;
      }
      await this.db.query(sql, params);
      return { data: null, error: null };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { data: null, error: { code: e.code, message: e.message ?? "erro" } };
    }
  }

  then<R1 = Result, R2 = never>(onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/** `{ from, rpc }` com a cara do cliente do Supabase, sobre um PGlite (schema wacrm). */
export function supabaseOverPglite(db: PGlite) {
  return {
    from: (table: string) => new Query(db, table),
    rpc: async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
      try {
        const keys = Object.keys(args);
        const call = keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ");
        const res = await db.query<Record<string, unknown>>(`SELECT wacrm.${ident(name)}(${call}) AS r`, keys.map((k) => args[k]));
        return { data: res.rows[0]?.r ?? null, error: null };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return { data: null, error: { code: e.code, message: e.message ?? "erro" } };
      }
    },
  };
}

export type PgliteSupabase = ReturnType<typeof supabaseOverPglite>;
