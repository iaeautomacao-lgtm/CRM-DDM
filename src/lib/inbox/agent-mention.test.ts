import { describe, expect, it } from "vitest";
import { mentionedAgentAlias } from "./agent-mention";

describe("mentionedAgentAlias", () => {
  it.each([
    ["@adriana", "adriana"],
    [" @Adriana ", "adriana"],
    ["@adriana por favor", "adriana"],
    ["@adriana, preciso conversar", "adriana"],
    ["@agente_02!", "agente_02"],
  ])("extracts the leading alias in %s", (text, alias) => {
    expect(mentionedAgentAlias(text)).toBe(alias);
  });
  it.each(["meu e-mail é pessoa@adriana.com", "Olá, @adriana", "@a", "@adriana12345678901234567890123456789", "@adriana-x", "", "contato comum"])("does not trigger on unrelated text %s", text => {
    expect(mentionedAgentAlias(text)).toBe(null);
  });
});
