import { describe, expect, it } from "vitest";
import { classifyPriorityIntent } from "./priority-intents";

describe("priority AI intents", () => {
  it("detects opt-out before normal negotiation", () => {
    expect(classifyPriorityIntent("Favor não me enviar mais mensagens")?.tag).toBe("#OPT_OUT");
    expect(classifyPriorityIntent("STOP")?.tag).toBe("#OPT_OUT");
  });

  it("detects wrong-contact situations", () => {
    expect(classifyPriorityIntent("Não me chamo Gleice")?.tag).toBe("#CONTATO_DIVERGENTE");
    expect(classifyPriorityIntent("Vocês enviaram errado, não sou a Gleice")?.tag).toBe("#CONTATO_DIVERGENTE");
  });

  it("detects explicit human requests", () => {
    expect(classifyPriorityIntent("Quero falar com um atendente")?.tag).toBe("#CLIENTE_PEDIU_HUMANO");
  });

  it("detects payment/contestations", () => {
    expect(classifyPriorityIntent("Essa pendência já foi paga hoje")?.tag).toBe("#CONTESTACAO_DIVIDA");
    expect(classifyPriorityIntent("Não reconheço essa dívida")?.tag).toBe("#CONTESTACAO_DIVIDA");
    expect(classifyPriorityIntent("Eu tranquei antes, isso está errado")?.tag).toBe("#CONTESTACAO_DIVIDA");
  });

  it("leaves ordinary negotiation messages to the LLM", () => {
    expect(classifyPriorityIntent("Quero negociar")).toBeNull();
    expect(classifyPriorityIntent("Boa tarde")).toBeNull();
  });
});
