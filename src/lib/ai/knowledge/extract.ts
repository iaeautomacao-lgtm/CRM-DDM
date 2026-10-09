// Extração de texto dos arquivos de conhecimento (TASK1-B), SÓ no servidor.
//
// TXT/MD/CSV: decodificados aqui (UTF-8; se não for UTF-8 válido, Windows-1252, comum em CSV do Excel).
// PDF (unpdf) e DOCX (mammoth): rodam num worker_thread separado, porque o parse é em boa parte SÍNCRONO
// (um Promise.race não interromperia) e o arquivo vem do usuário. O worker tem tempo máximo (terminate ao
// estourar) e teto de memória; acima de KB_MAX_PDF_PAGES o PDF é recusado antes de extrair. Sem OCR: PDF
// protegido por senha ou digitalizado (sem camada de texto) vira erro legível.
//
// O worker carrega as bibliotecas do node_modules do app em tempo de execução (createRequire a partir do
// diretório do app): nada de unpdf/mammoth entra no bundle do Next.

import "server-only";

import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
  KB_ACCEPT_LABEL,
  KB_EXTRACT_TIMEOUT_MS,
  KB_MAX_FILE_BYTES,
  KB_MAX_PDF_PAGES,
  KB_MAX_TEXT_CHARS,
  type KnowledgeFileKind,
} from "./limits";

export type ExtractErrorCode =
  | "unsupported"
  | "too_large"
  | "empty"
  | "text_too_long"
  | "pdf_encrypted"
  | "pdf_no_text"
  | "pdf_too_many_pages"
  | "pdf_invalid"
  | "docx_invalid"
  | "timeout"
  | "too_complex"
  | "busy";

export type ExtractResult =
  | { ok: true; text: string; pages?: number }
  | { ok: false; code: ExtractErrorCode; message: string };

export interface ExtractOptions {
  timeoutMs?: number;
  maxPages?: number;
  /** Diretório do app (onde está o node_modules). Padrão: process.cwd(). */
  appRoot?: string;
}

const MAX_CONCURRENT_WORKERS = 2;
let activeWorkers = 0;

function fail(code: ExtractErrorCode, detail?: { pages?: number }): ExtractResult {
  const messages: Record<ExtractErrorCode, string> = {
    unsupported: `Formato não aceito. Envie ${KB_ACCEPT_LABEL}.`,
    too_large: `Arquivo maior que ${Math.round(KB_MAX_FILE_BYTES / (1024 * 1024))} MB.`,
    empty: "O arquivo não tem texto.",
    text_too_long: `O texto extraído passa de ${KB_MAX_TEXT_CHARS.toLocaleString("pt-BR")} caracteres. Divida o arquivo e envie as partes.`,
    pdf_encrypted: "PDF sem texto extraível: o arquivo está protegido por senha. Remova a senha e envie de novo.",
    pdf_no_text: "PDF sem texto extraível: parece digitalizado (imagem). Envie um PDF com texto selecionável, um DOCX ou um TXT.",
    pdf_too_many_pages: `PDF com ${detail?.pages ?? "muitas"} páginas: o limite é ${KB_MAX_PDF_PAGES}. Divida o arquivo e envie as partes.`,
    pdf_invalid: "Não foi possível ler o PDF (arquivo corrompido ou inválido).",
    docx_invalid: "Não foi possível ler o DOCX (arquivo corrompido ou inválido).",
    timeout: `A extração passou de ${Math.round(KB_EXTRACT_TIMEOUT_MS / 1000)} s e foi interrompida. Divida o arquivo e tente de novo.`,
    too_complex: "O arquivo é complexo demais para extrair. Divida o arquivo e tente de novo.",
    busy: "Outro arquivo está sendo processado agora. Tente de novo em instantes.",
  };
  return { ok: false, code, message: messages[code] };
}

/** Quebras de linha uniformes, sem NUL e sem sequências longas de linhas em branco. */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeTextFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// Código do worker (CommonJS, eval). Responde UMA mensagem: { ok, text, pages } ou { ok: false, code, pages }.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const req = createRequire(workerData.packageJson);
const done = (msg) => parentPort.postMessage(msg);
(async () => {
  const bytes = new Uint8Array(workerData.bytes);
  if (workerData.kind === "pdf") {
    let pdf;
    try {
      const unpdf = req("unpdf");
      pdf = await unpdf.getDocumentProxy(bytes);
      if (pdf.numPages > workerData.maxPages) return done({ ok: false, code: "pdf_too_many_pages", pages: pdf.numPages });
      const out = await unpdf.extractText(pdf, { mergePages: false });
      return done({ ok: true, text: out.text.join("\\n\\n"), pages: pdf.numPages });
    } catch (err) {
      const name = err && err.name;
      return done({ ok: false, code: name === "PasswordException" ? "pdf_encrypted" : "pdf_invalid" });
    }
  }
  try {
    const mammoth = req("mammoth");
    const out = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return done({ ok: true, text: String(out.value || "") });
  } catch {
    return done({ ok: false, code: "docx_invalid" });
  }
})();
`;

type WorkerReply = { ok: true; text: string; pages?: number } | { ok: false; code: ExtractErrorCode; pages?: number };

function runWorker(kind: "pdf" | "docx", bytes: Uint8Array, opts: Required<ExtractOptions>): Promise<ExtractResult> {
  // Cópia própria: o buffer vai TRANSFERIDO para o worker.
  const copy = bytes.slice().buffer;
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { kind, bytes: copy, maxPages: opts.maxPages, packageJson: join(opts.appRoot, "package.json") },
      transferList: [copy],
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
      stdout: true,
      stderr: true,
    });
    const finish = (result: ExtractResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(fail("timeout")), opts.timeoutMs);
    worker.once("message", (reply: WorkerReply) => {
      if (reply.ok) finish({ ok: true, text: reply.text, pages: reply.pages });
      else finish(fail(reply.code, { pages: reply.pages }));
    });
    worker.once("error", (err: Error & { code?: string }) => {
      finish(err.code === "ERR_WORKER_OUT_OF_MEMORY" ? fail("too_complex") : fail(kind === "pdf" ? "pdf_invalid" : "docx_invalid"));
    });
    worker.once("exit", () => finish(fail(kind === "pdf" ? "pdf_invalid" : "docx_invalid")));
  });
}

/**
 * Extrai o texto de um arquivo de conhecimento. Nunca lança: erro vira `{ ok: false, message }` em português,
 * pronto para a tela.
 */
export async function extractKnowledgeText(
  kind: KnowledgeFileKind | null,
  bytes: Uint8Array,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  if (!kind) return fail("unsupported");
  if (bytes.byteLength > KB_MAX_FILE_BYTES) return fail("too_large");
  if (bytes.byteLength === 0) return fail("empty");

  let result: ExtractResult;
  if (kind === "text") {
    result = { ok: true, text: decodeTextFile(bytes) };
  } else {
    if (activeWorkers >= MAX_CONCURRENT_WORKERS) return fail("busy");
    activeWorkers += 1;
    try {
      result = await runWorker(kind, bytes, {
        timeoutMs: options.timeoutMs ?? KB_EXTRACT_TIMEOUT_MS,
        maxPages: options.maxPages ?? KB_MAX_PDF_PAGES,
        appRoot: options.appRoot ?? process.cwd(),
      });
    } finally {
      activeWorkers -= 1;
    }
  }
  if (!result.ok) return result;

  const text = normalizeExtractedText(result.text);
  if (text.replace(/\s/g, "").length === 0) return fail(kind === "pdf" ? "pdf_no_text" : "empty");
  if (text.length > KB_MAX_TEXT_CHARS) return fail("text_too_long");
  return { ok: true, text, pages: result.pages };
}
