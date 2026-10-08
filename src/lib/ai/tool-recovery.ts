export type ToolFailureCode =
  | "CPF_INVALIDO"
  | "TOOL_TIMEOUT"
  | "TOOL_RATE_LIMIT"
  | "TOOL_SERVER_ERROR"
  | "TOOL_HTTP_ERROR"
  | "TOOL_NETWORK_ERROR"
  | "TOOL_SCHEMA_ERROR"
  | "TOOL_INVALID_CLIENT"
  | "TOOL_PROVIDER_ERROR"
  // Resposta de NEGÓCIO da integração (HTTP 404, {"error":"CPF não
  // encontrado"}, "sem débito"…): a API está no ar e respondeu. Não é
  // instabilidade — o resultado vai ao modelo, que decide (ex.: pedir o
  // CPF de novo). Ver isIntegrationOutage.
  | "TOOL_BUSINESS_ERROR";

export interface ToolFailure {
  code: ToolFailureCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
}

export interface ToolExecutionMeta {
  attempts: number;
  recovered: boolean;
  failureCode?: ToolFailureCode;
  httpStatus?: number;
}

const SAFE_RETRY_TOOLS = new Set([
  "localizar_devedor",
  "consultar_debitos",
]);

export function normalizeCpf(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function isValidCpf(value: unknown): boolean {
  const cpf = normalizeCpf(value);
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calculateDigit = (length: number): number => {
    let sum = 0;
    for (let i = 0; i < length; i++) {
      sum += Number(cpf[i]) * (length + 1 - i);
    }
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };

  return (
    calculateDigit(9) === Number(cpf[9]) &&
    calculateDigit(10) === Number(cpf[10])
  );
}

export function prepareToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  required: string[] = [],
): { args: Record<string, unknown>; failure?: ToolFailure } {
  const normalized = { ...args };

  for (const key of required) {
    const value = normalized[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return {
        args: normalized,
        failure: {
          code: "TOOL_SCHEMA_ERROR",
          message: `Parâmetro obrigatório ausente: ${key}`,
          retryable: false,
        },
      };
    }
  }

  if (toolName === "localizar_devedor") {
    const cpf = normalizeCpf(normalized.cpf);
    normalized.cpf = cpf;

    if (!isValidCpf(cpf)) {
      return {
        args: normalized,
        failure: {
          code: "CPF_INVALIDO",
          message:
            "CPF inválido. Solicite novamente 11 dígitos válidos antes de consultar.",
          retryable: false,
        },
      };
    }
  }

  return { args: normalized };
}

// Mensagens de erro que são resultado de negócio, não falha da integração.
// Lista inicial — validar com a API DDM (PRD 01, Fase 1 item 3).
const BUSINESS_ERROR_PATTERNS: RegExp[] = [
  /\bnao (?:foi )?(?:encontrad|localizad)/,
  /\bnot found\b/,
  /\bsem (?:debito|pendencia|divida|registro|cadastro)/,
  /\bnenhuma? (?:registro|debito|pendencia|divida|resultado|cadastro|acordo|devedor|dado|calculo)/,
  /\binexistente\b/,
  /\bno (?:records?|data|results?)\b/,
];

/** Erro textual da integração que é resultado de negócio ("CPF não encontrado"). */
export function isBusinessErrorMessage(text: string): boolean {
  const normalized = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return BUSINESS_ERROR_PATTERNS.some((re) => re.test(normalized));
}

/** Trecho do corpo para o modelo (sem HTML de página de erro). */
function bodySnippet(body: string | undefined): string {
  const text = (body ?? "").trim();
  if (!text || /^<(!doctype html|html)\b/i.test(text)) return "";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function classifyHttpFailure(
  status: number,
  body?: string,
): ToolFailure | null {
  if (status >= 200 && status < 300) return null;

  // 404 = registro não encontrado (ex.: devedor inexistente). A API está
  // no ar: o modelo recebe o resultado e decide.
  if (status === 404) {
    const snippet = bodySnippet(body);
    return {
      code: "TOOL_BUSINESS_ERROR",
      message: `A integração respondeu que o registro não foi encontrado (HTTP 404)${snippet ? `: ${snippet}` : "."}`,
      retryable: false,
      httpStatus: status,
    };
  }

  if (status === 408 || status === 504) {
    return {
      code: "TOOL_TIMEOUT",
      message: "A integração excedeu o tempo de resposta.",
      retryable: true,
      httpStatus: status,
    };
  }

  if (status === 429) {
    return {
      code: "TOOL_RATE_LIMIT",
      message: "A integração limitou temporariamente novas requisições.",
      retryable: true,
      httpStatus: status,
    };
  }

  if (status >= 500) {
    return {
      code: "TOOL_SERVER_ERROR",
      message: "A integração retornou erro temporário de servidor.",
      retryable: true,
      httpStatus: status,
    };
  }

  return {
    code: "TOOL_HTTP_ERROR",
    message: `A integração retornou HTTP ${status}.`,
    retryable: false,
    httpStatus: status,
  };
}

// Resposta HTTP 200 que na verdade é erro em TEXTO (não JSON). A API DDM
// devolve, por exemplo, "Erro ao executar a query:" com status 200 — antes
// isso passava como sucesso, a IA recebia lixo e a conversa travava.
const TEXT_ERROR_PATTERNS: RegExp[] = [
  /^\s*(erro|error|exception|fatal)\b/i,
  /erro ao executar a query/i,
  /\b(sqlstate|syntax error|query failed|uncaught exception|stack trace)\b/i,
  /^\s*<(!doctype html|html)\b/i,
];

function classifyTextBodyFailure(body: string): ToolFailure | null {
  const text = body.trim();
  if (!text) {
    return {
      code: "TOOL_PROVIDER_ERROR",
      message: "A integração respondeu sem conteúdo.",
      retryable: true,
    };
  }
  if (TEXT_ERROR_PATTERNS.some((re) => re.test(text))) {
    return {
      code: "TOOL_SERVER_ERROR",
      message: `A integração retornou erro: ${text.slice(0, 120)}`,
      retryable: true,
    };
  }
  return null;
}

export function classifyToolBodyFailure(body: string): ToolFailure | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Não é JSON: pode ser texto de erro (ou HTML de erro do servidor).
    return classifyTextBodyFailure(body);
  }

  if (parsed === null || parsed === "") {
    return classifyTextBodyFailure("");
  }
  if (typeof parsed === "string") {
    return classifyTextBodyFailure(parsed);
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) {
    return null;
  }

  const errorValue = (parsed as { error?: unknown }).error;
  if (errorValue === null || errorValue === undefined || errorValue === false) {
    return null;
  }

  const rawError = String(errorValue).trim();
  if (!rawError) return null;

  if (rawError === "invalid_client") {
    return {
      code: "TOOL_INVALID_CLIENT",
      message: "A integração recusou temporariamente o identificador do cliente.",
      retryable: true,
    };
  }

  if (/timeout|timed out|aborted/i.test(rawError)) {
    return {
      code: "TOOL_TIMEOUT",
      message: "A integração excedeu o tempo de resposta.",
      retryable: true,
    };
  }

  if (/fetch failed|network|connection refused|econn/i.test(rawError)) {
    return {
      code: "TOOL_NETWORK_ERROR",
      message: "Falha de rede ao consultar a integração.",
      retryable: true,
    };
  }

  if (isBusinessErrorMessage(rawError)) {
    return {
      code: "TOOL_BUSINESS_ERROR",
      message: `A integração respondeu: ${rawError}`,
      retryable: false,
    };
  }

  return {
    code: "TOOL_PROVIDER_ERROR",
    message: `A integração rejeitou a operação: ${rawError}`,
    retryable: false,
  };
}

export function classifyFetchFailure(error: unknown): ToolFailure {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /timeout|timed out|aborted/i.test(message)
  ) {
    return {
      code: "TOOL_TIMEOUT",
      message: "A integração excedeu o tempo de resposta.",
      retryable: true,
    };
  }

  return {
    code: "TOOL_NETWORK_ERROR",
    message: "Falha de rede ao consultar a integração.",
    retryable: true,
  };
}

export function shouldRetryTool(
  toolName: string,
  method: string,
  failure: ToolFailure,
  attempt: number,
  maxAttempts = 3,
): boolean {
  return (
    attempt < maxAttempts &&
    method.toUpperCase() === "GET" &&
    SAFE_RETRY_TOOLS.has(toolName) &&
    failure.retryable
  );
}

export function retryDelayMs(attempt: number): number {
  return Math.min(300 * 2 ** Math.max(0, attempt - 1), 1200);
}

/**
 * Falha de INTEGRAÇÃO (fora do controle do cliente) — depois das
 * tentativas, a conversa não pode ficar parada esperando o modelo decidir:
 * ver forceInstabilityExit em responder.ts. CPF inválido, parâmetro
 * ausente e resposta de negócio (TOOL_BUSINESS_ERROR: 404, "CPF não
 * encontrado") não entram — o modelo resolve com o resultado.
 */
export function isIntegrationOutage(code: ToolFailureCode | undefined | null): boolean {
  return (
    code === "TOOL_TIMEOUT" ||
    code === "TOOL_RATE_LIMIT" ||
    code === "TOOL_SERVER_ERROR" ||
    code === "TOOL_HTTP_ERROR" ||
    code === "TOOL_NETWORK_ERROR" ||
    code === "TOOL_INVALID_CLIENT" ||
    code === "TOOL_PROVIDER_ERROR"
  );
}

/** Contagem por tool das chamadas de UMA resposta da IA. */
export interface ToolRoundTally {
  calls: number;
  outages: number;
  lastOutageCode: ToolFailureCode | null;
}

/**
 * Registra o resultado final (pós-tentativas) de UMA chamada de tool.
 * Conta por chamada, não por nome: 1 de 3 registros de consultar_debitos
 * falhando não derruba a resposta montada com os outros 2.
 */
export function tallyToolResult(
  tally: Map<string, ToolRoundTally>,
  toolName: string,
  failureCode: ToolFailureCode | undefined | null,
): void {
  const entry = tally.get(toolName) ?? { calls: 0, outages: 0, lastOutageCode: null };
  entry.calls += 1;
  if (failureCode && isIntegrationOutage(failureCode)) {
    entry.outages += 1;
    entry.lastOutageCode = failureCode;
  }
  tally.set(toolName, entry);
}

/**
 * Tools com TODAS as chamadas da rodada fora do ar — só então a resposta
 * é trocada por #INSTABILIDADE. Qualquer sucesso (ou resposta de negócio)
 * de qualquer registro da mesma tool tira a tool daqui.
 */
export function fullyFailedIntegrations(
  tally: Map<string, ToolRoundTally>,
): Record<string, ToolFailureCode> {
  const failed: Record<string, ToolFailureCode> = {};
  for (const [toolName, entry] of tally) {
    if (entry.calls > 0 && entry.outages === entry.calls && entry.lastOutageCode) {
      failed[toolName] = entry.lastOutageCode;
    }
  }
  return failed;
}

export function serializeToolFailure(
  failure: ToolFailure,
  attempts: number,
): string {
  return JSON.stringify({
    ok: false,
    error: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    http_status: failure.httpStatus ?? null,
    attempts,
  });
}

/** A tool pode ter efeito no mundo (método diferente de GET)? Tool desconhecida não conta. */
export function isEffectfulTool(
  tools: ReadonlyArray<{ name: string; http?: { method?: string } }> | undefined,
  toolName: string,
): boolean {
  const def = tools?.find((t) => t.name === toolName);
  return !!def && (def.http?.method ?? "GET").toUpperCase() !== "GET";
}

/**
 * Retry de "resposta vazia" do modelo. Só repete a chamada ao provider se NENHUMA tool com efeito rodou
 * no turno: repetir depois de, p.ex., `efetiva_acordo` reexecutaria a tool (acordo duplicado). Se rodou,
 * devolve o texto vazio e o chamador segue o caminho de fallback que já existe (nenhum texto muda).
 */
export async function retryEmptyReply(
  firstText: string,
  callAgain: () => Promise<string>,
  effectfulToolRan: boolean,
): Promise<{ text: string; retried: boolean; skippedForEffect: boolean }> {
  if (firstText) return { text: firstText, retried: false, skippedForEffect: false };
  if (effectfulToolRan) return { text: firstText, retried: false, skippedForEffect: true };
  return { text: await callAgain(), retried: true, skippedForEffect: false };
}
