import { describe, expect, it } from "vitest";
import { shouldCloseOnEscape } from "./dialog-keys";

// Alvo falso: `closest` responde "dentro de um popup" quando o seletor
// pedido inclui o role informado.
function target(insideRole: string | null) {
  return {
    closest: (selector: string) =>
      insideRole && selector.includes(`[role="${insideRole}"]`) ? {} : null,
  };
}

describe("shouldCloseOnEscape", () => {
  it("fecha com Escape vindo de um campo comum do modal", () => {
    expect(shouldCloseOnEscape("Escape", target(null))).toBe(true);
  });

  it("ignora outras teclas", () => {
    expect(shouldCloseOnEscape("Enter", target(null))).toBe(false);
    expect(shouldCloseOnEscape("Esc ", target(null))).toBe(false);
  });

  it("não fecha o modal quando o Esc nasce num Select/menu aberto", () => {
    expect(shouldCloseOnEscape("Escape", target("listbox"))).toBe(false);
    expect(shouldCloseOnEscape("Escape", target("menu"))).toBe(false);
  });

  it("respeita evento já tratado por outro handler", () => {
    expect(shouldCloseOnEscape("Escape", target(null), true)).toBe(false);
  });

  it("aceita alvo nulo ou sem closest", () => {
    expect(shouldCloseOnEscape("Escape", null)).toBe(true);
    expect(shouldCloseOnEscape("Escape", {})).toBe(true);
  });
});
