import { describe, expect, it } from "vitest";
import { describeAttemptStop, effectivePromptVersion, newAttemptTrace } from "./attempt-telemetry";
import { promptVersionOf } from "./prompt-versions";

describe("describeAttemptStop", () => {
  it("diz onde a tentativa parou", () => {
    const t = newAttemptTrace(0);
    expect(describeAttemptStop(t, "skipped")).toMatch(/antes de reservar/);
    expect(describeAttemptStop({ phase: "llm", tools: [] }, "failed")).toMatch(/chamada ao modelo/);
    expect(describeAttemptStop({ phase: "tool", tools: ["localizar_devedor"] }, "failed")).toBe(
      "Parou na ferramenta localizar_devedor",
    );
    expect(describeAttemptStop({ phase: "llm", tools: ["consultar_debitos"] }, "error")).toMatch(
      /depois da ferramenta consultar_debitos/,
    );
    expect(describeAttemptStop({ phase: "send", tools: [] }, "failed")).toBe("Parou no envio ao cliente");
    expect(describeAttemptStop({ phase: "persisted", tools: [] }, "sent")).toBe("Resposta enviada e gravada");
  });
});

describe("effectivePromptVersion", () => {
  it("usa o hash do prompt da conta, igual ao que a tela mostra", () => {
    const v = effectivePromptVersion({ hasOverride: false, accountPrompt: "Você é a Aleh." });
    expect(v).toBe(promptVersionOf("Você é a Aleh."));
    expect(v).toMatch(/^[0-9a-f]{12}$/);
  });

  it("sem prompt na conta (ou só espaços) cai no prompt interno", () => {
    expect(effectivePromptVersion({ hasOverride: false, accountPrompt: null })).toBe("default");
    expect(effectivePromptVersion({ hasOverride: false, accountPrompt: "   " })).toBe("default");
  });

  it("com override do nó devolve null — quem chama hasheia o texto cru", () => {
    expect(effectivePromptVersion({ hasOverride: true, accountPrompt: "conta" })).toBeNull();
  });

  it("hash do texto cru difere do texto com variáveis substituídas", () => {
    const raw = "Olá {{nome}}";
    expect(promptVersionOf(raw)).not.toBe(promptVersionOf("Olá Maria"));
    expect(promptVersionOf("")).toBeNull();
  });
});
