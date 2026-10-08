// ============================================================
// Exportação segura de planilhas (PRD 14, 14.6 — SG-18). MÓDULO PURO: serve ao servidor e ao navegador.
//
// Problema: uma célula que começa com `=`, `+`, `-`, `@`, TAB ou CR é lida como FÓRMULA pelo Excel/Sheets/LibreOffice. Dados vindos
// de fora (nome de perfil do WhatsApp, variáveis de CSV importado, texto de mensagem) chegam ao arquivo exportado e,
// por exemplo, um contato chamado `=HYPERLINK("http://x","clique")` vira link/exfiltração na planilha de um supervisor.
//
// Regra única: toda célula de TEXTO que comece com um desses caracteres recebe o prefixo `'` (convenção OWASP; a planilha
// mostra o texto original e não avalia). Números, booleanos e datas passam intactos.
//
// COMO USAR (todo ponto que gera CSV/XLSX — o teste csv-safe.scan.test.ts barra o que fugir):
//   - linhas de objetos para SheetJS:  XLSX.utils.json_to_sheet(safeRows(rows))
//   - CSV montado à mão:               values.map((v) => csvCell(v)).join(";")
//   - uma célula avulsa:               safeCell(value)
// Exportações assíncronas/novas (ex.: relatorios/exports do disparador) DEVEM usar estes helpers ao gerar o arquivo.
// ============================================================

/** Primeiro caractere que faz uma planilha tratar a célula como fórmula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Texto → texto neutralizado (prefixo `'` se começar como fórmula). */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** Célula → célula segura: só STRING é alterada; número/booleano/Date/null/undefined passam como estão. */
export function safeCell<T>(value: T): T | string {
  return typeof value === "string" ? neutralizeFormula(value) : value;
}

/** Linha (objeto) com todas as células seguras. */
export function safeRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safeCell(value)]));
}

export function safeRows<T extends Record<string, unknown>>(rows: readonly T[]): Record<string, unknown>[] {
  return rows.map((row) => safeRow(row));
}

/**
 * Célula de CSV: neutraliza fórmula (também em número formatado como texto, ex.: "+5511…") e escapa aspas, `;`,
 * quebras de linha. `null`/`undefined` viram vazio.
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = neutralizeFormula(text);
  return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Valor → texto neutralizado, SEM escapar para CSV (use quando o escape de aspas/separador é feito por outro lado). */
export function csvSafe(value: unknown): string {
  return neutralizeFormula(value === null || value === undefined ? "" : String(value));
}

/** Linha de CSV: cada célula por `csvCell`, juntas por `sep` (padrão `;`, o separador do Excel pt-BR). Sem quebra de linha final. */
export function csvLine(values: readonly unknown[], sep = ";"): string {
  return values.map((v) => csvCell(v)).join(sep);
}
