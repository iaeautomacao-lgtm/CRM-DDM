import { describe, expect, it } from "vitest";
import {
  classifyFetchFailure,
  classifyHttpFailure,
  classifyToolBodyFailure,
  fullyFailedIntegrations,
  isIntegrationOutage,
  isValidCpf,
  normalizeCpf,
  prepareToolArgs,
  retryDelayMs,
  serializeToolFailure,
  shouldRetryTool,
  tallyToolResult,
  type ToolRoundTally,
} from "./tool-recovery";

describe("tool recovery — CPF", () => {
  it("normalizes punctuation and validates CPF check digits", () => {
    expect(normalizeCpf("529.982.247-25")).toBe("52998224725");
    expect(isValidCpf("529.982.247-25")).toBe(true);
  });

  it("rejects invalid or repeated CPF digits", () => {
    expect(isValidCpf("529.982.247-24")).toBe(false);
    expect(isValidCpf("111.111.111-11")).toBe(false);
    expect(isValidCpf("123")).toBe(false);
  });

  it("normalizes localizar_devedor before the HTTP call", () => {
    const prepared = prepareToolArgs(
      "localizar_devedor",
      { cpf: "529.982.247-25" },
      ["cpf"],
    );
    expect(prepared.failure).toBeUndefined();
    expect(prepared.args.cpf).toBe("52998224725");
  });

  it("returns CPF_INVALIDO without calling the provider", () => {
    const prepared = prepareToolArgs(
      "localizar_devedor",
      { cpf: "111.111.111-11" },
      ["cpf"],
    );
    expect(prepared.failure?.code).toBe("CPF_INVALIDO");
    expect(prepared.failure?.retryable).toBe(false);
  });

  it("returns TOOL_SCHEMA_ERROR when a required argument is absent", () => {
    const prepared = prepareToolArgs(
      "consultar_debitos",
      { idDev: "123" },
      ["idDev", "cli"],
    );
    expect(prepared.failure?.code).toBe("TOOL_SCHEMA_ERROR");
  });
});

describe("tool recovery — HTTP classification", () => {
  it("classifies 429 and 5xx as retryable", () => {
    expect(classifyHttpFailure(429)?.code).toBe("TOOL_RATE_LIMIT");
    expect(classifyHttpFailure(503)?.code).toBe("TOOL_SERVER_ERROR");
    expect(classifyHttpFailure(503)?.retryable).toBe(true);
  });

  it("does not retry ordinary 4xx", () => {
    expect(classifyHttpFailure(400)?.code).toBe("TOOL_HTTP_ERROR");
    expect(classifyHttpFailure(400)?.retryable).toBe(false);
  });

  it("classifies timeout-like fetch failures", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(classifyFetchFailure(err).code).toBe("TOOL_TIMEOUT");
  });

  it("classifies provider error payloads returned with HTTP 200", () => {
    expect(
      classifyToolBodyFailure('{"error":"invalid_client"}'),
    ).toEqual(
      expect.objectContaining({
        code: "TOOL_INVALID_CLIENT",
        retryable: true,
      }),
    );

    expect(
      classifyToolBodyFailure('{"error":"invalid_simulation"}'),
    ).toEqual(
      expect.objectContaining({
        code: "TOOL_PROVIDER_ERROR",
        retryable: false,
      }),
    );

    expect(
      classifyToolBodyFailure('{"error":"The operation was aborted due to timeout"}'),
    ).toEqual(
      expect.objectContaining({
        code: "TOOL_TIMEOUT",
        retryable: true,
      }),
    );

    expect(classifyToolBodyFailure('{"error":null,"data":[]}')).toBeNull();
  });

  it("retries only known read-only DDM tools", () => {
    const failure = classifyHttpFailure(503)!;
    expect(shouldRetryTool("localizar_devedor", "GET", failure, 1, 3)).toBe(true);
    expect(shouldRetryTool("consultar_debitos", "GET", failure, 2, 3)).toBe(true);
    expect(shouldRetryTool("consultar_debitos", "GET", failure, 3, 3)).toBe(false);

    // efetiva_acordo is a side-effecting GET in the upstream API.
    // Never replay it automatically after an unknown outcome.
    expect(shouldRetryTool("efetiva_acordo", "GET", failure, 1, 3)).toBe(false);
  });

  it("uses bounded exponential backoff", () => {
    expect(retryDelayMs(1)).toBe(300);
    expect(retryDelayMs(2)).toBe(600);
    expect(retryDelayMs(3)).toBe(1200);
    expect(retryDelayMs(4)).toBe(1200);
  });

  it("serializes a safe structured error for the model", () => {
    const failure = classifyHttpFailure(503)!;
    expect(JSON.parse(serializeToolFailure(failure, 3))).toEqual({
      ok: false,
      error: "TOOL_SERVER_ERROR",
      message: "A integração retornou erro temporário de servidor.",
      retryable: true,
      http_status: 503,
      attempts: 3,
    });
  });
});

describe("classifyToolBodyFailure — erro em texto (HTTP 200)", () => {
  it("reconhece o erro da API DDM em texto puro", () => {
    const f = classifyToolBodyFailure("Erro ao executar a query: ");
    expect(f?.code).toBe("TOOL_SERVER_ERROR");
    expect(f?.retryable).toBe(true);
  });
  it("reconhece HTML de erro, corpo vazio e string JSON de erro", () => {
    expect(classifyToolBodyFailure("<!DOCTYPE html><html><body>502</body></html>")?.code).toBe("TOOL_SERVER_ERROR");
    expect(classifyToolBodyFailure("")?.code).toBe("TOOL_PROVIDER_ERROR");
    expect(classifyToolBodyFailure('"Erro interno"')?.code).toBe("TOOL_SERVER_ERROR");
  });
  it("não acusa resposta válida", () => {
    expect(classifyToolBodyFailure('{"nome":"Maria","debitos":[]}')).toBeNull();
    expect(classifyToolBodyFailure("[]")).toBeNull();
    expect(classifyToolBodyFailure("Cliente localizado: Maria")).toBeNull();
  });
});

describe("isIntegrationOutage", () => {
  it("integração fora do ar sim; CPF inválido e parâmetro ausente não", () => {
    expect(isIntegrationOutage("TOOL_SERVER_ERROR")).toBe(true);
    expect(isIntegrationOutage("TOOL_TIMEOUT")).toBe(true);
    expect(isIntegrationOutage("CPF_INVALIDO")).toBe(false);
    expect(isIntegrationOutage("TOOL_SCHEMA_ERROR")).toBe(false);
    expect(isIntegrationOutage(undefined)).toBe(false);
  });

  it("resposta de negócio não é instabilidade", () => {
    expect(isIntegrationOutage("TOOL_BUSINESS_ERROR")).toBe(false);
    expect(isIntegrationOutage("TOOL_INVALID_CLIENT")).toBe(true);
  });
});

describe("resposta de negócio (404 / erro de negócio no JSON)", () => {
  it("HTTP 404 vira TOOL_BUSINESS_ERROR com o corpo para o modelo", () => {
    const f = classifyHttpFailure(404, '{"msg":"Devedor não encontrado"}');
    expect(f?.code).toBe("TOOL_BUSINESS_ERROR");
    expect(f?.retryable).toBe(false);
    expect(f?.httpStatus).toBe(404);
    expect(f?.message).toContain("Devedor não encontrado");
    expect(classifyHttpFailure(404, "<html><body>Not Found</body></html>")?.message).not.toContain("<html>");
  });

  it("outros 4xx seguem como TOOL_HTTP_ERROR", () => {
    expect(classifyHttpFailure(401)?.code).toBe("TOOL_HTTP_ERROR");
    expect(classifyHttpFailure(403)?.code).toBe("TOOL_HTTP_ERROR");
  });

  it.each([
    '{"error":"CPF não encontrado"}',
    '{"error":"Devedor nao localizado"}',
    '{"error":"Not found"}',
    '{"error":"Sem débitos para o CPF informado"}',
    '{"error":"Nenhum registro encontrado"}',
  ])("erro de negócio no JSON: %s", (body) => {
    const f = classifyToolBodyFailure(body);
    expect(f?.code).toBe("TOOL_BUSINESS_ERROR");
    expect(f?.retryable).toBe(false);
    expect(isIntegrationOutage(f?.code)).toBe(false);
  });

  it("erro técnico no JSON continua como falha da integração", () => {
    expect(classifyToolBodyFailure('{"error":"invalid_client"}')?.code).toBe("TOOL_INVALID_CLIENT");
    expect(classifyToolBodyFailure('{"error":"Nenhum token informado"}')?.code).toBe("TOOL_PROVIDER_ERROR");
    expect(classifyToolBodyFailure('{"error":"database down"}')?.code).toBe("TOOL_PROVIDER_ERROR");
  });
});

describe("instabilidade forçada — contagem por chamada", () => {
  it("1 de 3 registros falhando não força instabilidade", () => {
    const tally = new Map<string, ToolRoundTally>();
    tallyToolResult(tally, "consultar_debitos", undefined);
    tallyToolResult(tally, "consultar_debitos", undefined);
    tallyToolResult(tally, "consultar_debitos", "TOOL_SERVER_ERROR");
    expect(fullyFailedIntegrations(tally)).toEqual({});
  });

  it("sucesso depois da falha também não força", () => {
    const tally = new Map<string, ToolRoundTally>();
    tallyToolResult(tally, "localizar_devedor", "TOOL_TIMEOUT");
    tallyToolResult(tally, "localizar_devedor", undefined);
    expect(fullyFailedIntegrations(tally)).toEqual({});
  });

  it("todas as chamadas fora do ar forçam", () => {
    const tally = new Map<string, ToolRoundTally>();
    tallyToolResult(tally, "localizar_devedor", undefined);
    tallyToolResult(tally, "consultar_debitos", "TOOL_TIMEOUT");
    tallyToolResult(tally, "consultar_debitos", "TOOL_SERVER_ERROR");
    expect(fullyFailedIntegrations(tally)).toEqual({ consultar_debitos: "TOOL_SERVER_ERROR" });
  });

  it("resposta de negócio e CPF inválido não forçam", () => {
    const tally = new Map<string, ToolRoundTally>();
    tallyToolResult(tally, "localizar_devedor", "TOOL_BUSINESS_ERROR");
    tallyToolResult(tally, "localizar_devedor", "CPF_INVALIDO");
    expect(fullyFailedIntegrations(tally)).toEqual({});
  });
});
