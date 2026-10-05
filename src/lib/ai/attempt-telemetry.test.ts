import { describe, expect, it } from "vitest";
import { describeAttemptStop, newAttemptTrace } from "./attempt-telemetry";

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
