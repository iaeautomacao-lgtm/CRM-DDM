import { describe, expect, it } from "vitest";

import { automatedAuthor, GENERIC_AUTOMATION } from "./message-origin";

describe("automatedAuthor (item 21 fase 2)", () => {
  it("rotula cada origem automática", () => {
    expect(automatedAuthor("ai", "bot")?.label).toBe("IA");
    expect(automatedAuthor("flow", "bot")?.label).toBe("Fluxo");
    expect(automatedAuthor("campaign", "agent")?.label).toBe("Disparo");
    expect(automatedAuthor("automation", "bot")?.label).toBe("Automação");
    expect(automatedAuthor("api", "agent")?.label).toBe("API");
  });

  it("origem automática vale mesmo com sender_type agent", () => {
    expect(automatedAuthor("campaign", "agent")?.bot).toBe(true);
  });

  it("cliente e operador ficam com o rótulo da pessoa", () => {
    expect(automatedAuthor("operator", "agent")).toBeNull();
    expect(automatedAuthor("customer", "customer")).toBeNull();
  });

  it("NULL em mensagem de bot vira Automação genérica", () => {
    expect(automatedAuthor(null, "bot")).toBe(GENERIC_AUTOMATION);
    expect(automatedAuthor(undefined, "bot")).toBe(GENERIC_AUTOMATION);
  });

  it("NULL em mensagem de agente segue a pessoa", () => {
    expect(automatedAuthor(null, "agent")).toBeNull();
  });

  it("origem desconhecida não quebra", () => {
    expect(automatedAuthor("toString", "bot")).toBe(GENERIC_AUTOMATION);
    expect(automatedAuthor("algo-novo", "agent")).toBeNull();
  });
});
