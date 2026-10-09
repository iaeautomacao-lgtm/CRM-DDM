// Extração de texto dos arquivos de conhecimento (TASK1-B). PDFs gerados aqui mesmo (sem binário no repo);
// PDF/DOCX passam pelo worker real (unpdf/mammoth do node_modules).

import { describe, expect, it } from "vitest";

import { decodeTextFile, extractKnowledgeText, normalizeExtractedText } from "./extract";
import { KB_MAX_FILE_BYTES, knowledgeFileKind, knowledgeMimeType } from "./limits";

/** PDF 1.4 mínimo, uma página por texto, fonte Helvetica. Texto sem parênteses/barra invertida. */
function buildPdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("knowledgeFileKind / knowledgeMimeType", () => {
  it("aceita PDF, DOCX, TXT, MD e CSV pela extensão (maiúscula também) e recusa o resto", () => {
    expect(knowledgeFileKind("Manual.PDF")).toBe("pdf");
    expect(knowledgeFileKind("contrato.docx")).toBe("docx");
    expect(knowledgeFileKind("faq.md")).toBe("text");
    expect(knowledgeFileKind("tabela.csv")).toBe("text");
    expect(knowledgeFileKind("notas.txt")).toBe("text");
    expect(knowledgeFileKind("planilha.xlsx")).toBeNull();
    expect(knowledgeFileKind("antigo.doc")).toBeNull();
    expect(knowledgeFileKind("sem-extensao")).toBeNull();
    expect(knowledgeMimeType("tabela.csv", "text")).toBe("text/csv");
    expect(knowledgeMimeType("faq.md", "text")).toBe("text/markdown");
    expect(knowledgeMimeType("a.pdf", "pdf")).toBe("application/pdf");
  });
});

describe("texto (TXT/MD/CSV)", () => {
  it("UTF-8 com BOM e CRLF vira texto normalizado", async () => {
    const r = await extractKnowledgeText("text", utf8("﻿linha 1\r\nlinha 2  \r\n\r\n\r\n\r\nfim"));
    expect(r).toEqual({ ok: true, text: "linha 1\nlinha 2\n\nfim", pages: undefined });
  });

  it("CSV em Windows-1252 (Excel) é decodificado sem perder acentos", () => {
    const latin1 = Uint8Array.from([0x6e, 0xe3, 0x6f, 0x3b, 0x61, 0xe7, 0xe3, 0x6f]); // "não;ação"
    expect(decodeTextFile(latin1)).toBe("não;ação");
  });

  it("arquivo vazio ou só com espaços é recusado", async () => {
    expect(await extractKnowledgeText("text", new Uint8Array())).toMatchObject({ ok: false, code: "empty" });
    expect(await extractKnowledgeText("text", utf8("  \n\t "))).toMatchObject({ ok: false, code: "empty" });
  });

  it("formato desconhecido e arquivo acima do teto são recusados antes de ler", async () => {
    expect(await extractKnowledgeText(null, utf8("x"))).toMatchObject({ ok: false, code: "unsupported" });
    const big = new Uint8Array(KB_MAX_FILE_BYTES + 1);
    expect(await extractKnowledgeText("text", big)).toMatchObject({ ok: false, code: "too_large", message: "Arquivo maior que 10 MB." });
  });

  it("normalizeExtractedText remove NUL e excesso de linhas em branco", () => {
    expect(normalizeExtractedText("a\u0000b\n\n\n\nc")).toBe("ab\n\nc");
  });
});

describe("PDF (worker com unpdf)", { timeout: 60_000 }, () => {
  it("extrai o texto de todas as páginas e informa o número de páginas", async () => {
    const r = await extractKnowledgeText("pdf", buildPdf(["Ola mundo pagina um", "Segunda pagina"]));
    expect(r).toEqual({ ok: true, text: "Ola mundo pagina um\n\nSegunda pagina", pages: 2 });
  });

  it("PDF sem camada de texto (digitalizado) vira erro legível", async () => {
    const r = await extractKnowledgeText("pdf", buildPdf([""]));
    expect(r).toMatchObject({ ok: false, code: "pdf_no_text" });
    if (!r.ok) expect(r.message).toMatch(/^PDF sem texto extraível/);
  });

  it("acima do teto de páginas recusa antes de extrair", async () => {
    const r = await extractKnowledgeText("pdf", buildPdf(["um", "dois", "tres"]), { maxPages: 2 });
    expect(r).toMatchObject({ ok: false, code: "pdf_too_many_pages" });
    if (!r.ok) expect(r.message).toContain("3 páginas");
  });

  it("arquivo que não é PDF vira pdf_invalid (sem derrubar o processo)", async () => {
    expect(await extractKnowledgeText("pdf", utf8("isto não é um pdf"))).toMatchObject({ ok: false, code: "pdf_invalid" });
  });

  it("estourar o tempo encerra o worker e devolve timeout", async () => {
    const r = await extractKnowledgeText("pdf", buildPdf(["lento"]), { timeoutMs: 1 });
    expect(r).toMatchObject({ ok: false, code: "timeout" });
  });
});

describe("DOCX (worker com mammoth)", { timeout: 60_000 }, () => {
  it("arquivo que não é DOCX vira docx_invalid", async () => {
    expect(await extractKnowledgeText("docx", utf8("PK isto não é um zip"))).toMatchObject({ ok: false, code: "docx_invalid" });
  });
});
