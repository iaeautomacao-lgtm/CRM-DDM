import { describe, expect, it } from "vitest";

import { formatCappedTotal, pageCount, readCappedTotal } from "./capped-label";

describe("formatCappedTotal", () => {
  it("com teto atingido mostra '100 mil+'", () => {
    expect(formatCappedTotal(100000, true, 100000)).toBe("100 mil+");
    expect(formatCappedTotal(250000, true, 250000)).toBe("250 mil+");
    expect(formatCappedTotal(1500, true, 1500)).toBe("1.500+");
  });

  it("sem teto mostra o número exato em pt-BR", () => {
    expect(formatCappedTotal(0, false, 100000)).toBe("0");
    expect(formatCappedTotal(12345, false, 100000)).toBe("12.345");
  });
});

describe("pageCount", () => {
  it("nunca menos de 1 e limitado ao teto quando total == cap", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(101, 50)).toBe(3);
    expect(pageCount(100000, 50)).toBe(2000);
    expect(pageCount(10, 0)).toBe(10);
  });
});

describe("readCappedTotal", () => {
  it("rota antiga (sem os campos aditivos) vale como sem teto", () => {
    expect(readCappedTotal({ total: 7 })).toEqual({ total: 7, capped: false, cap: 100000 });
    expect(readCappedTotal(null)).toEqual({ total: 0, capped: false, cap: 100000 });
  });

  it("lê total_capped e total_cap", () => {
    expect(readCappedTotal({ total: 100000, total_capped: true, total_cap: 100000 })).toEqual({
      total: 100000,
      capped: true,
      cap: 100000,
    });
  });
});
