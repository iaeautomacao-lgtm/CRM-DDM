import { describe, expect, it } from "vitest";
import { canConfirmPipelineDelete, pipelineDeleteWarning } from "./delete-warning";

describe("pipelineDeleteWarning", () => {
  it("diz que apaga definitivamente e traz a contagem real", () => {
    const t = pipelineDeleteWarning({ name: "Vendas", stages: 5, deals: 1234 });
    expect(t).toContain("Excluir definitivamente o funil “Vendas”");
    expect(t).toContain("5 etapas");
    expect(t).toContain("1.234 negócios");
    expect(t).toContain("não ficam arquivados");
    expect(t).not.toMatch(/arquivar os negócios/);
  });

  it("usa o singular", () => {
    const t = pipelineDeleteWarning({ name: "X", stages: 1, deals: 1 });
    expect(t).toContain("1 etapa ");
    expect(t).toContain("1 negócio.");
  });

  it("não inventa número quando a contagem falhou", () => {
    const t = pipelineDeleteWarning({ name: "X", stages: 3, deals: null });
    expect(t).toContain("todos os negócios dele");
    expect(t).toContain("não foi possível contar");
  });
});

describe("canConfirmPipelineDelete", () => {
  it("exige o nome igual", () => {
    expect(canConfirmPipelineDelete("Vendas", "Vendas")).toBe(true);
    expect(canConfirmPipelineDelete("  Vendas ", "Vendas")).toBe(true);
    expect(canConfirmPipelineDelete("vendas", "Vendas")).toBe(false);
    expect(canConfirmPipelineDelete("", "Vendas")).toBe(false);
    expect(canConfirmPipelineDelete("", "")).toBe(false);
  });
});
