export type ToolFailureCode =
  | "CPF_INVALIDO"
  | "TOOL_TIMEOUT"
  | "TOOL_RATE_LIMIT"
  | "TOOL_SERVER_ERROR"
  | "TOOL_HTTP_ERROR"
  | "TOOL_NETWORK_ERROR"
  | "TOOL_SCHEMA_ERROR"
  | "TOOL_INVALID_CLIENT"
  | "TOOL_PROVIDER_ERROR";

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

export function classifyHttpFailure(status: number): ToolFailure | null {
  if (status >= 200 && status < 300) return null;

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

export function classifyToolBodyFailure(body: string): ToolFailure | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
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
