import { describe, expect, it } from "vitest";
import { sectionTotal, shouldAutoLoadMore } from "./pagination";

describe("shouldAutoLoadMore", () => {
  const base = { nextCursor: "x|y", loading: false, loadingMore: false, failed: false };
  it("carrega quando há cursor e nada em andamento", () => expect(shouldAutoLoadMore(base)).toBe(true));
  it("não carrega sem cursor", () => expect(shouldAutoLoadMore({ ...base, nextCursor: null })).toBe(false));
  it("não carrega concorrente", () => {
    expect(shouldAutoLoadMore({ ...base, loadingMore: true })).toBe(false);
    expect(shouldAutoLoadMore({ ...base, loading: true })).toBe(false);
  });
  it("para após falha", () => expect(shouldAutoLoadMore({ ...base, failed: true })).toBe(false));
});

describe("sectionTotal", () => {
  it("usa o carregado quando não há mais páginas", () => expect(sectionTotal(12, 30, false)).toBe(12));
  it("usa o total do servidor quando há mais páginas", () => expect(sectionTotal(12, 130, true)).toBe(130));
  it("nunca fica abaixo do carregado", () => expect(sectionTotal(12, 10, true)).toBe(12));
  it("sem total do servidor, usa o carregado", () => expect(sectionTotal(12, null, true)).toBe(12));
});
