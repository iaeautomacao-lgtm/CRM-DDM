import { describe, expect, it } from "vitest";
import { offsetError, validateStepDrafts, windowError } from "./client-validation";

describe("billing/client-validation", () => {
  it("janela: fim depois do início e as duas pontas preenchidas", () => {
    expect(windowError("08:00", "20:00")).toBeNull();
    expect(windowError("20:00", "08:00")).toBe("O fim da janela deve ser depois do início.");
    expect(windowError("08:00", "08:00")).toBe("O fim da janela deve ser depois do início.");
    expect(windowError("", "20:00")).toBe("Informe o início e o fim da janela.");
  });

  it("dias: vazio não vira zero; inteiro entre -60 e 365", () => {
    expect(offsetError("")).toBe("Informe os dias.");
    expect(offsetError("  ")).toBe("Informe os dias.");
    expect(offsetError("0")).toBeNull();
    expect(offsetError("-60")).toBeNull();
    expect(offsetError("365")).toBeNull();
    expect(offsetError("366")).toContain("365");
    expect(offsetError("-61")).toContain("-60");
    expect(offsetError("1.5")).toBe("Use um número inteiro de dias.");
    expect(offsetError("abc")).toBe("Use um número inteiro de dias.");
  });

  it("etapas: dia repetido e gatilho vazio", () => {
    const errors = validateStepDrafts([
      { key: "a", kind: "offset", offset: "-3", status_trigger: "" },
      { key: "b", kind: "offset", offset: "-3", status_trigger: "" },
      { key: "c", kind: "offset", offset: "", status_trigger: "" },
      { key: "d", kind: "status", offset: "", status_trigger: "  " },
      { key: "e", kind: "status", offset: "", status_trigger: "negociando" },
    ]);
    expect(errors.has("a")).toBe(false);
    expect(errors.get("b")?.offset).toBe("Já existe uma etapa neste dia.");
    expect(errors.get("c")?.offset).toBe("Informe os dias.");
    expect(errors.get("d")?.status_trigger).toBe("Informe o status que dispara a etapa.");
    expect(errors.has("e")).toBe(false);
  });
});
