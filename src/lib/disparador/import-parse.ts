// Leitura da base (CSV/XLSX) no assistente "Nova campanha" e o resumo que a
// tela mostra antes de importar: válidos, duplicados, inválidos e na
// blacklist. Funções puras (o XLSX é convertido em matriz pelo componente).
//
// Espelha a importação do servidor (api/disparador/contacts/import):
//   - mesmo separador (linha "sep=", senão vírgula × ponto e vírgula na
//     primeira linha), para o mapeamento de colunas valer lá também;
//   - mesma ordem de descarte: telefone ausente/inválido → blacklist →
//     duplicado (mesmo phoneKey ou mesmo CPF já visto no arquivo).
// Antes o assistente fazia `resolved.rows.some(...)` dentro de um laço
// sobre todas as linhas (O(n²): 50 mil linhas travavam o navegador); aqui
// tudo é O(n) com Set/Map.

import * as Papa from "papaparse";
import {
  looksLikeImportHeader,
  normalizeImportHeader,
  type ImportColumnMap,
  type ResolvedImportRow,
} from "@/lib/disparador/import-mapping";
import { formatBrazilianPhone, phoneKey } from "@/lib/disparador/phone-key";

export interface ParsedImportTable {
  headers: string[];
  rows: string[][];
  hasHeader: boolean;
}

/** Separador como o servidor detecta; devolve o conteúdo sem BOM e sem "sep=". */
export function detectImportDelimiter(text: string): { delimiter: string; content: string } {
  let content = text.replace(/^﻿/, "");
  const firstLineEnd = content.indexOf("\n");
  const firstLine = (firstLineEnd >= 0 ? content.slice(0, firstLineEnd) : content).trim();
  if (/^sep=/i.test(firstLine)) {
    const delimiter = firstLine.split("=")[1]?.trim() || ";";
    content = firstLineEnd >= 0 ? content.slice(firstLineEnd + 1) : "";
    return { delimiter, content };
  }
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return { delimiter: commas > semicolons ? "," : ";", content };
}

/** Matriz de células → cabeçalho (detectado) + linhas não vazias. */
export function tableFromMatrix(matrix: readonly (readonly unknown[])[]): ParsedImportTable {
  const clean = matrix
    .map((row) => row.map((v) => String(v ?? "").replace(/\r/g, "").trim()))
    .filter((row) => row.some((v) => v !== ""));
  if (clean.length === 0) return { headers: [], rows: [], hasHeader: false };
  const first = clean[0].map((v) => v.replace(/"/g, ""));
  const hasHeader = looksLikeImportHeader(first);
  const width = Math.max(...clean.map((r) => r.length));
  const headers = (hasHeader ? first : Array.from({ length: width }, (_, i) => `coluna_${i + 1}`)).map(
    normalizeImportHeader
  );
  return { headers, rows: hasHeader ? clean.slice(1) : clean, hasHeader };
}

/** CSV/TXT → tabela (aspas e separador tratados pelo papaparse). */
export function parseImportCsv(text: string): ParsedImportTable {
  const { delimiter, content } = detectImportDelimiter(text);
  const parsed = Papa.parse<string[]>(content, { delimiter, skipEmptyLines: true });
  return tableFromMatrix(parsed.data);
}

/** CPF com exatamente 11 dígitos (mesma regra do import do servidor). */
export function normalizeImportCpf(raw: string | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

/** Telefone BR com DDD (10 ou 11 dígitos, com ou sem 55). */
export function isPlausibleBrPhone(raw: string): boolean {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  return d.length === 10 || d.length === 11;
}

export interface ImportSummary {
  total: number;
  validos: number;
  duplicados: number;
  invalidos: number;
  blacklist: number;
  /** Linhas que entram na campanha (válidas, únicas, fora da blacklist). */
  rows: ResolvedImportRow[];
}

/**
 * Resumo da base com o mapeamento atual. `blacklistKeys` = phoneKey dos
 * telefones da base que estão na blacklist (conferido no servidor); null =
 * ainda não conferido (conta 0).
 */
export function summarizeImport(
  table: ParsedImportTable,
  columnMap: ImportColumnMap,
  blacklistKeys: ReadonlySet<string> | null = null
): ImportSummary {
  const index = (header: string | undefined) => (header ? table.headers.indexOf(header) : -1);
  const phoneIdx = index(columnMap.phone);
  const nameIdx = index(columnMap.name);
  const cpfIdx = index(columnMap.cpf);
  const varIdx = [index(columnMap.var1), index(columnMap.var2), index(columnMap.var3)];

  const summary: ImportSummary = { total: table.rows.length, validos: 0, duplicados: 0, invalidos: 0, blacklist: 0, rows: [] };
  const seenPhones = new Set<string>();
  const seenCpfs = new Set<string>();
  for (const values of table.rows) {
    const rawPhone = phoneIdx >= 0 ? (values[phoneIdx] ?? "").trim() : "";
    if (!rawPhone || !isPlausibleBrPhone(rawPhone)) {
      summary.invalidos++;
      continue;
    }
    const phone = formatBrazilianPhone(rawPhone);
    const key = phoneKey(phone);
    if (blacklistKeys?.has(key)) {
      summary.blacklist++;
      continue;
    }
    const rawCpf = cpfIdx >= 0 ? (values[cpfIdx] ?? "").trim() : "";
    const cpf = normalizeImportCpf(rawCpf);
    if (seenPhones.has(key) || (cpf !== null && seenCpfs.has(cpf))) {
      summary.duplicados++;
      continue;
    }
    seenPhones.add(key);
    if (cpf) seenCpfs.add(cpf);
    summary.rows.push({
      phone: rawPhone,
      name: nameIdx >= 0 ? (values[nameIdx] ?? "").trim() || undefined : undefined,
      cpf: rawCpf || undefined,
      variables: varIdx.map((i) => (i >= 0 ? (values[i] ?? "").trim() : "")) as [string, string, string],
      raw: Object.fromEntries(table.headers.map((h, i) => [h, values[i] ?? ""])),
    });
  }
  summary.validos = summary.rows.length;
  return summary;
}
