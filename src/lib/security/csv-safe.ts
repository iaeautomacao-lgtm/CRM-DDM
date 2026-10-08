// ============================================================
// Exportação segura de planilhas (PRD 14, 14.6 — SG-18). MÓDULO PURO: serve ao servidor e ao navegador.
// É o ÚNICO módulo de CSV seguro do projeto (a exportação assíncrona do disparador, lib/disparador/export-jobs.ts, usa este).
//
// Problema: uma célula que começa com `=`, `+`, `-`, `@`, TAB ou CR é lida como FÓRMULA pelo Excel/Sheets/LibreOffice. Dados vindos
// de fora (nome de perfil do WhatsApp, variáveis de CSV importado, texto de mensagem) chegam ao arquivo exportado e,
// por exemplo, um contato chamado `=HYPERLINK("http://x","clique")` vira link/exfiltração na planilha de um supervisor.
//
// REGRA (uma só): toda célula de TEXTO que comece com `=`, `@`, TAB ou CR — ou com `+`/`-` — recebe o prefixo `'` (convenção
// OWASP; a planilha mostra o texto original e não avalia). ÚNICA exceção: `+`/`-` seguido de dígito e só de dígitos,
// espaço, parênteses, ponto e hífen (`+5511999990000`, `+55 (11) 99999-0000`, `-5`): telefone/número em texto não vira
// fórmula executável (nenhuma função, referência ou operador `+`/`|`/`!` cabe nesse padrão) e continua legível.
// `+1+cmd|' /C calc'!A0` e `-2+3` NÃO cabem na exceção e são neutralizados. Números, booleanos e datas passam intactos.
//
// COMO USAR (todo ponto que gera CSV/XLSX — o teste csv-safe.test.ts varre src/ e barra o que fugir):
//   - linhas de objetos para SheetJS:  XLSX.utils.json_to_sheet(safeRows(rows))
//   - CSV montado à mão:               csvLine([a, b, c])   (ou csvCell por célula)
//   - uma célula avulsa:               safeCell(value)
// Exportações assíncronas/novas DEVEM usar estes helpers ao gerar o arquivo.
// ============================================================

/** `+`/`-` seguido de dígito e só de dígitos, espaço, parênteses, ponto e hífen: telefone/número, não fórmula executável. */
const NUMERIC_LIKE = /^[+-]\d[\d\s().-]*$/;

/** O texto começaria como fórmula numa planilha (e não é número/telefone)? */
function startsLikeFormula(text: string): boolean {
  if (/^[=@\t\r]/.test(text)) return true;
  return /^[+-]/.test(text) && !NUMERIC_LIKE.test(text);
}

/** Texto → texto neutralizado (prefixo `'` se começar como fórmula). */
export function neutralizeFormula(text: string): string {
  return startsLikeFormula(text) ? `'${text}` : text;
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

/** Valor → texto neutralizado, SEM escapar para CSV (use quando o escape de aspas/separador é feito por outro lado). */
export function csvSafe(value: unknown): string {
  return neutralizeFormula(value === null || value === undefined ? "" : String(value));
}

/** Célula de CSV: neutraliza fórmula e escapa aspas, `;` e quebras de linha. `null`/`undefined` viram vazio. */
export function csvCell(value: unknown): string {
  const safe = csvSafe(value);
  return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Linha de CSV terminada em CRLF: `csvCell` em cada valor, juntos por `sep` (padrão `;`, o separador do Excel pt-BR). */
export function csvLine(cells: readonly unknown[], sep = ";"): string {
  return `${cells.map((c) => csvCell(c)).join(sep)}\r\n`;
}
