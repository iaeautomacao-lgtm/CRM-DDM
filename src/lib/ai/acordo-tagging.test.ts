import { describe, expect, it, vi } from "vitest";
import {
  ACORDO_REALIZADO_CODIGO,
  buildAcordoPrompt,
  classifyAcordoFormalizado,
  parseAcordoResponse,
} from "./acordo-tagging";

describe("ACORDO_REALIZADO_CODIGO", () => {
  it("matches the seeded outcome tag's codigo_tabulacao (migration 041)", () => {
    expect(ACORDO_REALIZADO_CODIGO).toBe(142);
  });
});

describe("parseAcordoResponse", () => {
  it("parses a clean JSON true", () => {
    expect(parseAcordoResponse('{"acordo_formalizado": true}')).toBe(true);
  });

  it("parses a clean JSON false", () => {
    expect(parseAcordoResponse('{"acordo_formalizado": false}')).toBe(false);
  });

  it("strips a ```json code fence before parsing", () => {
    expect(
      parseAcordoResponse('```json\n{"acordo_formalizado": true}\n```'),
    ).toBe(true);
  });

  it("defaults to false on malformed JSON", () => {
    expect(parseAcordoResponse("not json at all")).toBe(false);
  });

  it("defaults to false when the field is missing", () => {
    expect(parseAcordoResponse("{}")).toBe(false);
  });

  it("defaults to false on a non-boolean value (string 'true')", () => {
    expect(parseAcordoResponse('{"acordo_formalizado": "true"}')).toBe(false);
  });

  it("defaults to false on a non-boolean value ('sim')", () => {
    expect(parseAcordoResponse('{"acordo_formalizado": "sim"}')).toBe(false);
  });
});

describe("classifyAcordoFormalizado", () => {
  // The mocked `callLlm` stands in for the real LLM call — it returns the
  // JSON a model would produce for the given transcript, so these tests
  // cover "our code turns an LLM answer into a conservative true/false"
  // without ever hitting a real network/model.

  it("returns true for a clear, formalized agreement", async () => {
    const history = [
      "Cliente: Quanto fica pra pagar a vista?",
      "Atendente: Fica R$500 com 20% de desconto, tudo quitado.",
      "Cliente: Fechado, pode gerar o boleto.",
    ].join("\n");
    const callLlm = vi.fn().mockResolvedValue('{"acordo_formalizado": true}');

    const result = await classifyAcordoFormalizado(history, callLlm);

    expect(result).toBe(true);
    expect(callLlm).toHaveBeenCalledExactlyOnceWith(buildAcordoPrompt(history));
  });

  it("returns false for vague interest with no confirmation", async () => {
    const history = [
      "Cliente: Oi, vi que tenho uma pendencia",
      "Atendente: Sim, podemos negociar um desconto pra voce",
      "Cliente: Ah legal, deixa eu pensar e te retorno",
    ].join("\n");
    const callLlm = vi.fn().mockResolvedValue('{"acordo_formalizado": false}');

    expect(await classifyAcordoFormalizado(history, callLlm)).toBe(false);
  });

  it("returns false for an ambiguous conversation", async () => {
    const history = [
      "Cliente: Voces cobram juros?",
      "Atendente: Depende da condicao escolhida",
      "Cliente: Entendi",
    ].join("\n");
    const callLlm = vi.fn().mockResolvedValue('{"acordo_formalizado": false}');

    expect(await classifyAcordoFormalizado(history, callLlm)).toBe(false);
  });

  it("returns false (never throws) when the LLM call rejects", async () => {
    const callLlm = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(classifyAcordoFormalizado("qualquer historico", callLlm)).resolves.toBe(
      false,
    );
  });

  it("returns false when the LLM responds with malformed JSON", async () => {
    const callLlm = vi.fn().mockResolvedValue("desculpe, nao entendi");

    expect(await classifyAcordoFormalizado("historico", callLlm)).toBe(false);
  });
});

describe("buildAcordoPrompt", () => {
  it("embeds the conversation history and asks for a strict boolean field", () => {
    const prompt = buildAcordoPrompt("Cliente: oi\nAtendente: ola");
    expect(prompt).toContain("Cliente: oi");
    expect(prompt).toContain("acordo_formalizado");
    expect(prompt).toContain("Na dúvida, responda SEMPRE \"false\"");
  });
});
