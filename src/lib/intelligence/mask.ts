// Mascaramento de dados pessoais de devedores nos resultados das
// ferramentas do Intelligence expostos FORA do CRM (MCP, PRD-04 Fase 3).
// Ponto único: o servidor MCP passa todo resultado por maskPersonalData
// antes de devolver ao assistente externo.
//
// O que as ferramentas devolvem hoje: search_conversations só tem
// metadados (ids, nomes de equipe/instituição/atendente, datas) — sem CPF
// ou telefone. get_conversation_timeline devolve o TEXTO das mensagens
// (até 500 caracteres cada) e resumos de auditoria, onde o cliente pode ter
// digitado CPF, CNPJ ou telefone. Por isso o mascaramento é por padrão de
// texto em todas as strings do resultado (números JSON — métricas — não
// são tocados):
//
//   CPF      123.456.789-12        → ***.***.***-12
//   CNPJ     12.345.678/0001-90    → **.***.***/****-90
//   telefone +55 (11) 91234-5678   → +55 11 9****-5678
//   dígitos  11 seguidos (CPF ou celular com DDD, ambíguos) → ***.***.***-NN
//            12–13 começando com 55 → +55 DD 9****-NNNN; 14 → CNPJ;
//            8–10 → telefone; demais → asteriscos + 2 últimos dígitos.
//
// Sequências coladas a letras, hífens, pontos ou barras (UUIDs, datas ISO,
// prefixos de chave) não casam.

const CNPJ_FORMATTED = /(?<![\w.\-/])\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?![\w\-/])/g;
const CPF_FORMATTED = /(?<![\w.\-/])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\w\-/])/g;
/** Telefone com alguma formatação: +55, (DDD) ou separador entre as metades. */
const PHONE_FORMATTED =
  /(?<![\w+\-./])(?:\+?55[\s.]?)?(?:\(\d{2}\)\s?|\d{2}[\s.-])?9?\d{4}[\s.-]\d{4}(?![\w\-/])/g;
/** Sequência longa de dígitos (com + opcional), sem formatação. */
const DIGIT_RUN = /(?<![\w+\-./])\+?\d{8,14}(?![\w\-/])/g;

function tail(digits: string, n: number): string {
  return digits.slice(-n);
}

/** Telefone pelos dígitos (8 a 13): mantém DDI/DDD e os 4 últimos. */
function maskPhoneDigits(digits: string): string {
  let rest = digits;
  let country = "";
  if (rest.length >= 12 && rest.startsWith("55")) {
    country = "+55 ";
    rest = rest.slice(2);
  }
  let ddd = "";
  if (rest.length >= 10) {
    ddd = `${rest.slice(0, 2)} `;
    rest = rest.slice(2);
  }
  const nine = rest.length === 9 ? "9" : "";
  return `${country}${ddd}${nine}****-${tail(rest, 4)}`;
}

function maskCpfDigits(digits: string): string {
  return `***.***.***-${tail(digits, 2)}`;
}

function maskCnpjDigits(digits: string): string {
  return `**.***.***/****-${tail(digits, 2)}`;
}

function maskDigitRun(run: string): string {
  const digits = run.replace(/\D/g, "");
  const n = digits.length;
  if (n === 11) return maskCpfDigits(digits);
  if (n === 14) return maskCnpjDigits(digits);
  if (n >= 8 && n <= 10) return maskPhoneDigits(digits);
  if ((n === 12 || n === 13) && digits.startsWith("55")) return maskPhoneDigits(digits);
  return `${"*".repeat(Math.max(0, n - 2))}${tail(digits, 2)}`;
}

/** Mascara CPF, CNPJ e telefones dentro de um texto. */
export function maskPersonalText(text: string): string {
  return text
    .replace(CNPJ_FORMATTED, (m) => maskCnpjDigits(m.replace(/\D/g, "")))
    .replace(CPF_FORMATTED, (m) => maskCpfDigits(m.replace(/\D/g, "")))
    .replace(PHONE_FORMATTED, (m) => maskPhoneDigits(m.replace(/\D/g, "")))
    .replace(DIGIT_RUN, maskDigitRun);
}

/** Aplica maskPersonalText em todas as strings de um valor JSON. */
export function maskPersonalData<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return maskPersonalText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
    return out;
  }
  return value;
}
