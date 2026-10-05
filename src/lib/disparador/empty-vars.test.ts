import { describe, expect, it } from "vitest";
import { describeEmptyTemplateVar, describeUnresolvedPlaceholder } from "./empty-vars";

describe("variáveis vazias na campanha", () => {
  it("Meta: aponta a primeira vazia", () => {
    expect(describeEmptyTemplateVar(["Maria", "R$ 10"])).toBeNull();
    expect(describeEmptyTemplateVar(["Maria", " "])).toMatch(/\{\{2\}\} vazia/);
  });
  it("WAHA: vazia na substituição ou {{n}} que sobrou", () => {
    expect(describeUnresolvedPlaceholder("Olá Maria", null)).toBeNull();
    expect(describeUnresolvedPlaceholder("Olá ", 1)).toMatch(/\{\{1\}\} vazia/);
    expect(describeUnresolvedPlaceholder("Olá {{2}}", null)).toMatch(/\{\{2\}\} sem valor mapeado/);
  });
});
