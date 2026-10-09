// Colunas REAIS das tabelas (extraídas de supabase/migrations) para os testes (PRD 14, 14.12).
//
// Origem do helper: o hotfix #143 nasceu de selects de colunas que não existiam (`phone_number`, `display_name`) e que os mocks de banco
// aceitaram em silêncio — o teste passava, a produção quebrava. Aqui o mock deixa de aceitar coluna inventada:
//
//   assertColumns("whatsapp_config", "id, provider, display_phone_number")  // colunas de um select/filtro
//   assertRowColumns("channel_health", [{ session_id: "s1", quality_rating: "GREEN" }])  // linhas que o mock devolve
//
// Só vale para tabelas criadas/alteradas nas migrations do repositório (`CREATE TABLE` + `ADD COLUMN`); tabela sem nenhuma coluna
// extraída lança erro (em vez de aprovar tudo). As migrations podem não refletir 100% a produção: coluna que o código usa e
// nenhuma migration declara é justamente o sinal de alerta.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");

let sources: string[] | null = null;
function migrationSources(): string[] {
  if (!sources) {
    sources = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8").replace(/--.*$/gm, ""));
  }
  return sources;
}

const TABLE = (name: string) => `(?:wacrm\\.)?${name}`;
const cache = new Map<string, Set<string>>();

/** Colunas de um CREATE TABLE (primeira definição) + todos os ADD COLUMN dos ALTER TABLE da tabela. */
export function columnsOf(table: string): Set<string> {
  const cached = cache.get(table);
  if (cached) return cached;
  const cols = new Set<string>();
  for (const sql of migrationSources()) {
    const create = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${TABLE(table)}\\s*\\(([\\s\\S]*?)\\n\\);`, "i").exec(sql);
    if (create) {
      for (const line of create[1].split("\n")) {
        const m = /^\s*([a-z_][a-z0-9_]*)\s+(?:uuid|text|bigint|integer|int|boolean|numeric|timestamptz|timestamp|jsonb|bytea)/i.exec(line);
        if (m) cols.add(m[1].toLowerCase());
      }
    }
    for (const alter of sql.matchAll(new RegExp(`ALTER TABLE(?: ONLY)? ${TABLE(table)}\\b([^;]*);`, "gi"))) {
      for (const add of alter[1].matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) cols.add(add[1].toLowerCase());
    }
  }
  cache.set(table, cols);
  return cols;
}

/** Tokens de um select("a, b:c, d") → colunas reais (alias `b:c` conta `c`); ignora `*` e relações `x(...)`. */
export function selectColumns(list: string): string[] {
  return list
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && t !== "*" && !t.includes("(") && !t.includes(")"))
    .map((t) => (t.includes(":") ? t.split(":")[1].trim() : t));
}

function known(table: string): Set<string> {
  const cols = columnsOf(table);
  if (cols.size === 0) {
    throw new Error(`assertColumns: nenhuma coluna de "${table}" foi extraída das migrations (tabela criada fora delas?) — não dá para validar`);
  }
  return cols;
}

/** Lança se alguma coluna (de um select "a, b, c" ou de uma lista) não existir na tabela. */
export function assertColumns(table: string, columns: string | readonly string[]): void {
  const real = known(table);
  const wanted = typeof columns === "string" ? selectColumns(columns) : [...columns];
  const missing = wanted.filter((c) => !real.has(c.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`coluna(s) inexistente(s) em ${table}: ${missing.join(", ")} — nenhuma migration as cria (cuidado: foi assim que nasceu o #143)`);
  }
}

/** Valida as CHAVES das linhas que um mock de banco devolve; devolve as mesmas linhas (uso inline). */
export function assertRowColumns<T extends Record<string, unknown>>(table: string, rows: T[]): T[];
export function assertRowColumns<T extends Record<string, unknown>>(table: string, row: T): T;
export function assertRowColumns(table: string, rows: Record<string, unknown> | Record<string, unknown>[]): unknown {
  for (const row of Array.isArray(rows) ? rows : [rows]) assertColumns(table, Object.keys(row));
  return rows;
}
