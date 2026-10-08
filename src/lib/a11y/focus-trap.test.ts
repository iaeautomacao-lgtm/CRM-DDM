import { describe, expect, it } from "vitest";
import { findNextFocusable, getNextFocusableIndex } from "./focus-trap";

describe("getNextFocusableIndex", () => {
  it("retorna -1 quando não há elementos", () => {
    expect(getNextFocusableIndex(-1, 0, false)).toBe(-1);
    expect(getNextFocusableIndex(0, 0, false)).toBe(-1);
    expect(getNextFocusableIndex(-1, 0, true)).toBe(-1);
  });

  it("retorna 0 para lista com apenas 1 elemento, tanto para Tab quanto Shift+Tab", () => {
    expect(getNextFocusableIndex(-1, 1, false)).toBe(0);
    expect(getNextFocusableIndex(0, 1, false)).toBe(0);
    expect(getNextFocusableIndex(-1, 1, true)).toBe(0);
    expect(getNextFocusableIndex(0, 1, true)).toBe(0);
  });

  describe("ordem direta (Tab)", () => {
    it("avança para o primeiro elemento se nada estiver focado (-1)", () => {
      expect(getNextFocusableIndex(-1, 3, false)).toBe(0);
    });

    it("avança sequencialmente entre os elementos", () => {
      expect(getNextFocusableIndex(0, 3, false)).toBe(1);
      expect(getNextFocusableIndex(1, 3, false)).toBe(2);
    });

    it("faz loop circular voltando para o primeiro ao atingir o último", () => {
      expect(getNextFocusableIndex(2, 3, false)).toBe(0);
    });

    it("trata índice inválido além dos limites indo para o início", () => {
      expect(getNextFocusableIndex(10, 3, false)).toBe(0);
    });
  });

  describe("ordem reversa (Shift+Tab)", () => {
    it("vai para o último elemento se nada estiver focado (-1)", () => {
      expect(getNextFocusableIndex(-1, 3, true)).toBe(2);
    });

    it("retrocede sequencialmente entre os elementos", () => {
      expect(getNextFocusableIndex(2, 3, true)).toBe(1);
      expect(getNextFocusableIndex(1, 3, true)).toBe(0);
    });

    it("faz loop circular voltando para o último ao atingir o primeiro (índice 0)", () => {
      expect(getNextFocusableIndex(0, 3, true)).toBe(2);
    });

    it("trata índice inválido além dos limites indo para o último", () => {
      expect(getNextFocusableIndex(10, 3, true)).toBe(2);
    });
  });
});

describe("findNextFocusable", () => {
  const items = ["btn-fechar", "input-nome", "btn-salvar"];

  it("retorna null para array vazio", () => {
    expect(findNextFocusable([], null, false)).toBeNull();
  });

  it("com foco no container (null), Tab foca o primeiro elemento", () => {
    expect(findNextFocusable(items, null, false)).toBe("btn-fechar");
  });

  it("com foco no container (null), Shift+Tab foca o último elemento", () => {
    expect(findNextFocusable(items, null, true)).toBe("btn-salvar");
  });

  it("avança com Tab entre elementos", () => {
    expect(findNextFocusable(items, "btn-fechar", false)).toBe("input-nome");
    expect(findNextFocusable(items, "input-nome", false)).toBe("btn-salvar");
  });

  it("cicla com Tab do último de volta ao primeiro", () => {
    expect(findNextFocusable(items, "btn-salvar", false)).toBe("btn-fechar");
  });

  it("retrocede com Shift+Tab", () => {
    expect(findNextFocusable(items, "btn-salvar", true)).toBe("input-nome");
    expect(findNextFocusable(items, "input-nome", true)).toBe("btn-fechar");
  });

  it("cicla com Shift+Tab do primeiro de volta ao último", () => {
    expect(findNextFocusable(items, "btn-fechar", true)).toBe("btn-salvar");
  });

  it("funciona com predicado personalizado isCurrent", () => {
    interface FakeElement {
      id: string;
      children?: string[];
    }
    const elements: FakeElement[] = [
      { id: "modal-fechar" },
      { id: "grupo-botoes", children: ["filho-interno"] },
      { id: "modal-salvar" },
    ];

    // O elemento ativo é um filho dentro de 'grupo-botoes'
    const active = { id: "filho-interno" };
    const next = findNextFocusable(
      elements,
      active,
      false,
      (el, act) => el.id === act.id || Boolean(el.children?.includes(act.id))
    );

    expect(next?.id).toBe("modal-salvar");
  });
});
