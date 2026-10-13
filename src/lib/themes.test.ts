import { describe, expect, it } from "vitest";
import { resolveMode } from "./themes";

describe("resolveMode (tema pelo sistema)", () => {
  it("sem escolha salva, segue o sistema", () => {
    expect(resolveMode(null, true)).toBe("dark");
    expect(resolveMode(null, false)).toBe("light");
    expect(resolveMode("qualquer", false)).toBe("light");
  });

  it("a escolha salva vence o sistema", () => {
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });
});
