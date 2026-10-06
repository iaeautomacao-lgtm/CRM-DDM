import { describe, expect, it } from "vitest";
import { isTypingTarget, parseCollapsed } from "./use-sidebar-collapsed";

// Objeto mínimo com a forma de um HTMLElement — o ambiente de teste é node.
function el(tagName: string, opts: { editable?: boolean; attr?: string | null } = {}) {
  return {
    tagName,
    isContentEditable: opts.editable ?? false,
    getAttribute: (name: string) => (name === "contenteditable" ? (opts.attr ?? null) : null),
  } as unknown as EventTarget;
}

describe("isTypingTarget", () => {
  it("ignora o atalho em campos de texto", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("SELECT"))).toBe(true);
    expect(isTypingTarget(el("DIV", { editable: true }))).toBe(true);
    expect(isTypingTarget(el("DIV", { attr: "true" }))).toBe(true);
    expect(isTypingTarget(el("DIV", { attr: "" }))).toBe(true);
  });

  it("aceita o atalho fora de campos de texto", () => {
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(el("DIV", { attr: "false" }))).toBe(false);
    expect(isTypingTarget(el("BODY"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });
});

describe("parseCollapsed", () => {
  it("padrão é expandido", () => {
    expect(parseCollapsed(null)).toBe(false);
    expect(parseCollapsed("0")).toBe(false);
    expect(parseCollapsed("lixo")).toBe(false);
  });
  it("'1' é recolhido", () => {
    expect(parseCollapsed("1")).toBe(true);
  });
});
