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

  it("still detects wrong person with a name or 'essa pessoa'", () => {
    expect(classifyPriorityIntent("Não sou a Maria")?.tag).toBe("#CONTATO_DIVERGENTE");
    expect(classifyPriorityIntent("não sou essa pessoa")?.tag).toBe("#CONTATO_DIVERGENTE");
    expect(classifyPriorityIntent("Eu não sou o João")?.tag).toBe("#CONTATO_DIVERGENTE");
    expect(classifyPriorityIntent("não sou o titular")?.tag).toBe("#CONTATO_DIVERGENTE");
  });

  it("does not treat 'não sou …' expressions as wrong person", () => {
    expect(classifyPriorityIntent("Não sou capaz de pagar agora")).toBeNull();
    expect(classifyPriorityIntent("não sou obrigado a pagar juros")).toBeNull();
    expect(classifyPriorityIntent("não sou de fugir das minhas contas")).toBeNull();
    expect(classifyPriorityIntent("não sou o tipo de pessoa que deixa de pagar")).toBeNull();
    expect(classifyPriorityIntent("não sou caloteiro, só estou sem dinheiro")).toBeNull();
  });

  it("still detects explicit debt denial", () => {
    expect(classifyPriorityIntent("Não devo nada")?.tag).toBe("#CONTESTACAO_DIVIDA");
    expect(classifyPriorityIntent("eu não devo isso")?.tag).toBe("#CONTESTACAO_DIVIDA");
    expect(classifyPriorityIntent("Não devo!")?.tag).toBe("#CONTESTACAO_DIVIDA");
    expect(classifyPriorityIntent("Tranquei faz tempo")?.tag).toBe("#CONTESTACAO_DIVIDA");
  });

  it("does not treat 'não devo' / 'tranquei' in negotiation as contestation", () => {
    expect(classifyPriorityIntent("não devo conseguir pagar este mês")).toBeNull();
    expect(classifyPriorityIntent("tranquei a matrícula mas quero negociar")).toBeNull();
    expect(classifyPriorityIntent("Tranquei o curso, quanto fica pra pagar?")).toBeNull();
  });

  it("leaves ordinary negotiation messages to the LLM", () => {
    expect(classifyPriorityIntent("Quero negociar")).toBeNull();
    expect(classifyPriorityIntent("Boa tarde")).toBeNull();
  });
});
