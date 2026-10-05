import { describe, expect, it } from "vitest";
import {
  classifyFetchFailure,
  classifyHttpFailure,
  isValidCpf,
  normalizeCpf,
  prepareToolArgs,
  retryDelayMs,
  serializeToolFailure,
  shouldRetryTool,
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
