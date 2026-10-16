// Todo CSV que o usuário BAIXA sai com BOM UTF-8 e separador `;` (o Excel pt-BR só abre acentos e colunas corretamente assim).
// Este teste (1) prova cada gerador conhecido e (2) varre src/ e public/ para barrar um CSV novo que fuja da regra.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { errosToCsv } from "@/lib/disparador/erros";
import { MEMBER_IMPORT_TEMPLATE_CSV } from "@/lib/members/import-template";
import { sheetWriteOptions } from "@/lib/relatorios/export-with-history";
import { CSV_BOM, csvLine } from "@/lib/security/csv-safe";

const ROOT = process.cwd();
const BOM_BYTES = [0xef, 0xbb, 0xbf];

describe("geradores de CSV conhecidos", () => {
  it("relatórios (conversas, envio em lote, tabulações, atendimentos): SheetJS com `;` e BOM, com acentos intactos", () => {
    expect(sheetWriteOptions("csv")).toEqual({ bookType: "csv", FS: ";" });
    expect(sheetWriteOptions("xlsx")).toEqual({ bookType: "xlsx" });
    const ws = XLSX.utils.json_to_sheet([{ Nome: "João", Valor: "a;b", Obs: "x,y" }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Dados");
    const bytes = Buffer.from(XLSX.write(wb, { ...sheetWriteOptions("csv"), type: "base64" }) as string, "base64");
    expect([...bytes.subarray(0, 3)]).toEqual(BOM_BYTES);
    expect(bytes.toString("utf8")).toBe(`${CSV_BOM}Nome;Valor;Obs\nJoão;"a;b";x,y`);
  });

  it("modelo de importação de membros: BOM e `;`", () => {
    expect(MEMBER_IMPORT_TEMPLATE_CSV.startsWith(CSV_BOM)).toBe(true);
    const header = MEMBER_IMPORT_TEMPLATE_CSV.slice(1).split("\r\n")[0];
    expect(header).toBe("nome;email;role");
    expect(MEMBER_IMPORT_TEMPLATE_CSV).toContain("João Souza");
  });

  it("modelo estático de importação do Disparador (public/): BOM no início", () => {
    const bytes = readFileSync(resolve(ROOT, "public/modelo_importacao_disparador.csv"));
    expect([...bytes.subarray(0, 3)]).toEqual(BOM_BYTES);
    expect(bytes.toString("utf8")).toContain("sep=;");
  });

  it("erros do Disparador: BOM e `;`", () => {
    const csv = errosToCsv([]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.split("\r\n")[0]).toContain(";");
  });

  it("csvLine usa `;` por padrão (base das exportações assíncronas do Disparador e do Histórico)", () => {
    expect(csvLine(["a", "b"])).toBe("a;b\r\n");
  });
});

// ── varredura ─────────────────────────────────────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Quem PRODUZ um arquivo CSV de download (resposta text/csv, Blob csv, bookType csv). */
const PRODUCES_CSV = /text\/csv|bookType:\s*["']csv["']|\.csv["'`]\s*;?\s*$/m;
/** Marcas de que o arquivo cuida do BOM/`;` (literal do BOM, CSV_BOM, sheetWriteOptions, modelo/gerador que já o aplica). */
const HANDLES_BOM = /\\uFEFF|\uFEFF|CSV_BOM|sheetWriteOptions|MEMBER_IMPORT_TEMPLATE_CSV|errosToCsv/;

/** Exceções documentadas: citam CSV, mas não geram o arquivo baixado. */
const NOT_A_DOWNLOAD: Record<string, string> = {
  "lib/ai/knowledge/limits.ts": "lista de extensões aceitas no upload (entrada, não saída)",
  "lib/ai/knowledge/extract.ts": "leitura de arquivo da base de conhecimento (entrada)",
  "lib/api/v1/extract.ts": "mapa de tipos MIME de anexos de mensagens",
  "app/api/relatorios/exports/route.ts": "guarda os bytes que o navegador gerou com sheetWriteOptions (só declara o content-type)",
  "app/api/historico/exports/route.ts": "agenda o job; o CSV é montado em lib/historico/export-jobs.ts (BOM + `;`)",
  "app/api/disparador/erros/route.ts": "devolve o CSV montado por errosToCsv (BOM + `;`)",
  "app/(dashboard)/disparador/erros/page.tsx": "só baixa o que o servidor devolve",
  "app/(dashboard)/relatorios/custos-ia/page.tsx": "só baixa o CSV de /api/costs/ai (BOM + `;` pelo csv-safe na rota)",
  "components/contacts/import-modal.tsx": "importação: só o accept do upload (entrada)",
  "components/disparador/nova-campanha/step-origem.tsx": "importação: só o accept e o texto do upload (entrada)",
  "components/disparador/export/campaign-exports.tsx":"botão que baixa o CSV do job assíncrono (BOM + `;` em lib/disparador/export-jobs.ts)",
};

describe("varredura: CSV novo precisa de BOM e `;`", () => {
  const SRC = resolve(ROOT, "src");
  const rel = (p: string) => relative(SRC, p).split("\\").join("/");
  const files = walk(SRC).filter((p) => PRODUCES_CSV.test(readFileSync(p, "utf8")));

  it("encontra os pontos de geração conhecidos (a varredura não ficou cega)", () => {
    const found = files.map(rel);
    for (const known of ["lib/relatorios/export-with-history.ts", "lib/disparador/export-jobs.ts", "lib/historico/export-jobs.ts", "components/settings/bulk-import-members-dialog.tsx"]) {
      expect(found, known).toContain(known);
    }
  });

  it("todo arquivo que produz CSV trata o BOM (ou é exceção documentada)", () => {
    const offenders = files.filter((p) => !HANDLES_BOM.test(readFileSync(p, "utf8")) && !(rel(p) in NOT_A_DOWNLOAD)).map(rel);
    expect(offenders, "gerador de CSV sem BOM — use CSV_BOM/sheetWriteOptions (src/lib/security/csv-safe.ts)").toEqual([]);
  });

  it("as exceções continuam existindo", () => {
    for (const path of Object.keys(NOT_A_DOWNLOAD)) {
      expect(statSync(resolve(SRC, path)).isFile(), path).toBe(true);
    }
  });
});
