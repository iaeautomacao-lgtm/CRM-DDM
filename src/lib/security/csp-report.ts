// Relatórios de violação do CSP (POST do navegador para /api/security/csp-report). Puro e testável.
// Aceita os dois formatos: `report-uri` ({"csp-report": {...}}, application/csp-report) e a Reporting API (lista de {type:"csp-violation", body}).
// Guarda SÓ o que ajuda a ajustar a política e nada que identifique a pessoa: URL sem query/fragmento, diretiva, origem do bloqueado, linha.
// Nunca guarda `script-sample`, `referrer` nem `original-policy`.

export interface CspViolation {
  documentPath: string | null;
  directive: string | null;
  blocked: string | null;
  sourceFile: string | null;
  line: number | null;
  column: number | null;
  disposition: string | null;
}

const MAX_REPORTS = 10;
const KEYWORDS = new Set(["inline", "eval", "wasm-eval", "data", "blob", "self", "filesystem", "mediastream"]);

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/** `https://host/caminho` (sem query e sem fragmento); texto que não é URL vira null. */
function pathOnly(raw: unknown): string | null {
  const s = str(raw, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`.slice(0, 200);
  } catch {
    return null;
  }
}

/** O que foi bloqueado: palavra-chave (inline, eval, data…) ou só a ORIGEM da URL (o caminho pode ter token). */
function blockedOrigin(raw: unknown): string | null {
  const s = str(raw, 500);
  if (!s) return null;
  if (KEYWORDS.has(s)) return s;
  try {
    const u = new URL(s);
    return u.origin === "null" ? u.protocol : u.origin.slice(0, 200);
  } catch {
    return null;
  }
}

function normalize(body: Record<string, unknown>): CspViolation {
  return {
    documentPath: pathOnly(body["document-uri"] ?? body["documentURL"] ?? body["documentUri"]),
    directive: str(body["effective-directive"] ?? body["effectiveDirective"] ?? body["violated-directive"] ?? body["violatedDirective"], 80),
    blocked: blockedOrigin(body["blocked-uri"] ?? body["blockedURL"] ?? body["blockedUri"]),
    sourceFile: pathOnly(body["source-file"] ?? body["sourceFile"]),
    line: num(body["line-number"] ?? body["lineNumber"]),
    column: num(body["column-number"] ?? body["columnNumber"]),
    disposition: str(body["disposition"], 20),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Extrai e higieniza as violações de um corpo JSON (até 10 por chamada). Corpo estranho devolve lista vazia. */
export function sanitizeCspReports(payload: unknown): CspViolation[] {
  const out: CspViolation[] = [];
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items.slice(0, MAX_REPORTS)) {
    if (!isRecord(item)) continue;
    if (isRecord(item["csp-report"])) out.push(normalize(item["csp-report"]));
    else if (item["type"] === "csp-violation" && isRecord(item["body"])) out.push(normalize(item["body"]));
  }
  return out;
}
