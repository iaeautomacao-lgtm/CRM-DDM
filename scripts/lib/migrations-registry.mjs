// Registro de migrations (PRD 15, 15.3) — lógica PURA (sem rede): lista os arquivos de supabase/migrations,
// monta o required-migrations.json, acha números duplicados e compara com o relatório do banco
// (wacrm.schema_check_report(), migration 202). Usada por scripts/schema-check.mjs, pelo job de CI e pelos testes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A 202 começa a rastrear: o schema:check só exige migrations >= esta. */
export const MIN_VERSION = 183;

/** Números que já existiam duplicados ANTES do registro (dois arquivos com o mesmo número); não mexer neles. */
export const LEGACY_DUPLICATE_NUMBERS = ["113", "132", "133", "143"];

const FILE_RE = /^(\d+)([a-z]?)_.+\.sql$/;

/** Nomes (sem .sql) das migrations numeradas, em ordem natural. */
export function listMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((f) => f.slice(0, -".sql".length))
    .sort(compareVersions);
}

export function parseVersion(name) {
  const m = name.match(/^(\d+)([a-z]?)_/);
  if (!m) return null;
  return { number: Number(m[1]), suffix: m[2], key: `${m[1]}${m[2]}` };
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (pa.number !== pb.number) return pa.number - pb.number;
  if (pa.suffix !== pb.suffix) return pa.suffix < pb.suffix ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Números repetidos (dois `194_…` ou dois `194b_…`). `187` e `187b` NÃO são duplicata. Os legados
 * (LEGACY_DUPLICATE_NUMBERS, anteriores ao registro) são ignorados.
 */
export function findDuplicateNumbers(names, legacy = LEGACY_DUPLICATE_NUMBERS) {
  const groups = new Map();
  for (const name of names) {
    const p = parseVersion(name);
    if (!p) continue;
    if (legacy.includes(String(p.number)) && p.suffix === "") continue;
    const list = groups.get(p.key) ?? [];
    list.push(name);
    groups.set(p.key, list);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 1).map(([key, files]) => ({ key, files }));
}

/** Nome do índice criado por um CREATE INDEX CONCURRENTLY no SQL (sem schema), ou null. */
export function concurrentIndexName(sql) {
  // só o código: os comentários do cabeçalho citam "CREATE INDEX CONCURRENTLY" em prosa
  const code = sql.replace(/^\s*--.*$/gm, "");
  const m = code.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/i);
  if (!m) return null;
  return m[1].replace(/"/g, "").split(".").pop();
}

/**
 * required-migrations.json a partir dos arquivos. `registry` = a migration se registra em wacrm.schema_migrations;
 * `index` = é um CREATE INDEX CONCURRENTLY (não pode se registrar numa transação): confere-se o ÍNDICE (e a validade).
 */
export function buildRequired(dir, minVersion = MIN_VERSION) {
  const migrations = [];
  for (const version of listMigrations(dir)) {
    const p = parseVersion(version);
    if (!p || p.number < minVersion) continue;
    const sql = readFileSync(join(dir, `${version}.sql`), "utf8");
    const index = concurrentIndexName(sql);
    migrations.push(index ? { version, kind: "index", index } : { version, kind: "registry" });
  }
  return { minVersion, migrations };
}

/**
 * Compara o exigido com o relatório do banco `{applied: string[], indexes: {name, valid}[]}`.
 * Estados: "aplicada" | "faltando" | "índice inválido".
 */
export function compareWithReport(required, report) {
  const applied = new Set(report?.applied ?? []);
  const indexes = new Map((report?.indexes ?? []).map((i) => [i.name, i.valid]));
  return required.migrations.map((m) => {
    if (m.kind === "index") {
      if (!indexes.has(m.index)) return { ...m, status: "faltando" };
      return { ...m, status: indexes.get(m.index) ? "aplicada" : "índice inválido" };
    }
    return { ...m, status: applied.has(m.version) ? "aplicada" : "faltando" };
  });
}

/** Tabela de texto + contagem. */
export function renderTable(rows) {
  const width = Math.max(...rows.map((r) => r.version.length), 9);
  const lines = rows.map((r) => {
    const mark = r.status === "aplicada" ? "ok " : "!! ";
    const extra = r.kind === "index" ? ` (índice ${r.index})` : "";
    return `${mark}${r.version.padEnd(width)}  ${r.status}${extra}`;
  });
  const count = (s) => rows.filter((r) => r.status === s).length;
  lines.push("", `aplicadas: ${count("aplicada")} · faltando: ${count("faltando")} · índice inválido: ${count("índice inválido")}`);
  return lines.join("\n");
}

/** Código de saída: 0 tudo aplicado; 1 faltando/inválido. */
export function exitCodeFor(rows) {
  return rows.every((r) => r.status === "aplicada") ? 0 : 1;
}

/**
 * Executa a verificação contra um cliente com `rpc(nome)` (supabase-js ou um adaptador de teste).
 * Devolve { code, output }. Registro ausente (202 não aplicada) = código 2.
 */
export async function runSchemaCheck(client, required) {
  const { data, error } = await client.rpc("schema_check_report");
  if (error) {
    const missing = error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message ?? "");
    if (missing) {
      return {
        code: 2,
        output: "O registro de migrations não existe no banco: aplique a migration 202_schema_migrations_registry.sql no SQL Editor e rode de novo.",
      };
    }
    return { code: 2, output: `Falha ao ler o registro de migrations: ${error.message}` };
  }
  const rows = compareWithReport(required, data);
  return { code: exitCodeFor(rows), output: renderTable(rows), rows };
}
