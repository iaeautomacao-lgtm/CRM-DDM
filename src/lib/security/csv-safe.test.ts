// PRD 14, 14.6 (SG-18): CSV/planilha sem fórmula. Helper único + varredura que barra geração de planilha sem ele
// (no mesmo espírito do teste do `new OpenAI(`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { csvCell, csvLine, csvSafe, neutralizeFormula, safeCell, safeRow, safeRows } from "./csv-safe";

describe("neutralizeFormula / safeCell", () => {
  it.each([
    ["=HYPERLINK(\"http://x\",\"a\")", "'=HYPERLINK(\"http://x\",\"a\")"],
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ["+5511999990001", "'+5511999990001"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\t=1+1", "'\t=1+1"],
    ["\r=1+1", "'\r=1+1"],
  ])("neutraliza %j", (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
    expect(safeCell(input)).toBe(expected);
  });

  it("não mexe em texto normal, vazio, nem em quem tem o gatilho DEPOIS do primeiro caractere", () => {
    for (const ok of ["Maria", "", " =x", "a=b", "R$ 10,00", "1+1", "'=já com aspas"]) expect(neutralizeFormula(ok)).toBe(ok);
  });

  it("só STRING é alterada: número (inclusive negativo), booleano, Date, null e undefined passam intactos", () => {
    const date = new Date("2026-10-08T12:00:00Z");
    expect(safeCell(-5)).toBe(-5);
    expect(safeCell(0)).toBe(0);
    expect(safeCell(true)).toBe(true);
    expect(safeCell(date)).toBe(date);
    expect(safeCell(null)).toBeNull();
    expect(safeCell(undefined)).toBeUndefined();
  });

  it("safeRow/safeRows tratam todas as células e não mutam a entrada", () => {
    const input = [{ Nome: "=evil()", Qtd: -3, Tel: "+55" }, { Nome: "ok", Qtd: 1, Tel: "" }];
    const out = safeRows(input);
    expect(out).toEqual([{ Nome: "'=evil()", Qtd: -3, Tel: "'+55" }, { Nome: "ok", Qtd: 1, Tel: "" }]);
    expect(input[0].Nome).toBe("=evil()");
    expect(safeRow({ a: "@x" })).toEqual({ a: "'@x" });
  });
});

describe("csvCell", () => {
  it("neutraliza e escapa (aspas, ponto e vírgula, quebra de linha)", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell("linha1\nlinha2")).toBe('"linha1\nlinha2"');
    expect(csvCell("=a;b")).toBe("\"'=a;b\"");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(131026)).toBe("131026");
    expect(csvCell(-1)).toBe("'-1"); // número já virado texto no CSV: o sinal vira "-1" literal na célula, sem fórmula
  });
});

describe("csvSafe / csvLine", () => {
  it("csvSafe neutraliza sem escapar; csvLine junta células já escapadas", () => {
    expect(csvSafe("=1+1")).toBe("'=1+1");
    expect(csvSafe("a;b")).toBe("a;b");
    expect(csvSafe(null)).toBe("");
    expect(csvSafe(-3)).toBe("'-3");
    expect(csvLine(["Maria", "=x", "a;b", 2, null])).toBe("Maria;'=x;\"a;b\";2;");
    expect(csvLine(["a", "b"], ",")).toBe("a,b");
  });
});

describe("exportWithHistory (navegador): o arquivo baixado E o enviado ao histórico saem neutralizados", () => {
  it("json_to_sheet recebe as células seguras", async () => {
    const captured: Record<string, unknown>[][] = [];
    vi.resetModules();
    vi.doMock("xlsx", () => ({
      utils: {
        json_to_sheet: (rows: Record<string, unknown>[]) => (captured.push(rows), {}),
        book_new: () => ({}),
        book_append_sheet: () => undefined,
      },
      write: () => "QUJD",
      writeFile: () => undefined,
    }));
    vi.doMock("@/lib/api-fetch", () => ({ apiFetch: async () => new Response("{}") }));
    const { exportWithHistory } = await import("@/lib/relatorios/export-with-history");
    await exportWithHistory({
      data: [{ nome: "=HYPERLINK(\"http://evil\")", fone: "+5511999990001", total: -4 }],
      columns: [
        { key: "nome", label: "Nome" },
        { key: "fone", label: "Telefone" },
        { key: "total", label: "Total" },
      ],
      exportType: "conversas",
      description: "teste",
      format: "csv",
    });
    expect(captured[0]).toEqual([{ Nome: "'=HYPERLINK(\"http://evil\")", Telefone: "'+5511999990001", Total: -4 }]);
    vi.doUnmock("xlsx");
    vi.doUnmock("@/lib/api-fetch");
  });
});

// ── varredura: quem GERA planilha/CSV usa o helper ─────────────────────────────────────────────────────────────────
const SRC = resolve(process.cwd(), "src");
const GENERATES = /(?:json_to_sheet|aoa_to_sheet|sheet_add_json|sheet_add_aoa)\s*\(|['"]Content-Type['"]\s*:\s*['"]text\/csv/;
const USES_HELPER = /@\/lib\/security\/csv-safe/;

/** Exceções documentadas: arquivos que casam o padrão mas NÃO geram células de dado (ou geram por outro módulo seguro). */
const ALLOWED_WITHOUT_HELPER: Record<string, string> = {
  "app/api/disparador/erros/route.ts": "só devolve o CSV montado por errosToCsv (lib/disparador/erros.ts, que usa o helper)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("varredura: geração de CSV/planilha sem o helper seguro", () => {
  const rel = (p: string) => relative(SRC, p).split("\\").join("/");
  // o próprio helper cita json_to_sheet na documentação
  const generators = walk(SRC)
    .filter((p) => rel(p) !== "lib/security/csv-safe.ts")
    .filter((p) => GENERATES.test(readFileSync(p, "utf8")));

  it("encontra os pontos de geração conhecidos (a varredura não ficou cega)", () => {
    const files = generators.map(rel);
    for (const known of [
      "lib/relatorios/export-with-history.ts",
      "app/api/audit-logs/route.ts",
      "app/api/disparador/campaigns/[id]/queue-details/route.ts",
      "app/api/disparador/erros/route.ts",
    ]) {
      expect(files, known).toContain(known);
    }
  });

  it("todo arquivo que gera planilha/CSV importa o helper (ou está na lista de exceções documentadas)", () => {
    const offenders = generators
      .filter((p) => !USES_HELPER.test(readFileSync(p, "utf8")) && !(rel(p) in ALLOWED_WITHOUT_HELPER))
      .map(rel);
    expect(offenders, `gera planilha/CSV sem @/lib/security/csv-safe: ${offenders.join(", ")}`).toEqual([]);
  });

  it("as exceções continuam valendo (arquivo existe e o gerador por trás usa o helper)", () => {
    for (const file of Object.keys(ALLOWED_WITHOUT_HELPER)) {
      expect(generators.map(rel), file).toContain(file);
    }
    expect(readFileSync(join(SRC, "lib/disparador/erros.ts"), "utf8")).toMatch(USES_HELPER);
  });
});
