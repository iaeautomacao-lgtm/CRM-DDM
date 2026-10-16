import { describe, expect, it } from "vitest";
import { capacityPerCore, coresUsed, fairness, jainIndex, numberRate, percentile, windowOf } from "./bench-stats";

describe("bench-stats", () => {
  it("percentil por posição (nearest-rank)", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 99)).toBe(7);
  });

  it("Jain: 1 quando iguais, 1/n quando um número leva tudo", () => {
    expect(jainIndex([80, 80, 80, 80])).toBeCloseTo(1, 10);
    expect(jainIndex([80, 0, 0, 0])).toBeCloseTo(0.25, 10);
    expect(jainIndex([])).toBe(1);
    expect(jainIndex([0, 0])).toBe(1);
  });

  it("recorta a janela e completa com zero", () => {
    expect(windowOf([1, 2, 3, 4], 1, 5)).toEqual([2, 3, 4, 0, 0]);
  });

  it("taxa por número: média, pico e pior trecho de 5 s", () => {
    const rate = numberRate("a", [80, 80, 80, 80, 80, 0, 0, 0, 0, 0]);
    expect(rate.mean).toBe(40);
    expect(rate.peak).toBe(80);
    expect(rate.worst5s).toBe(0);
    expect(rate.sends).toBe(400);
    expect(numberRate("b", [10, 10, 10]).worst5s).toBe(10); // janela menor que 5 s: usa a média
  });

  it("justiça: menor ÷ maior e menor ÷ meta", () => {
    const f = fairness([numberRate("a", [80, 80]), numberRate("b", [40, 40])], 80);
    expect(f.minOverMax).toBeCloseTo(0.5, 10);
    expect(f.minOverTarget).toBeCloseTo(0.5, 10);
    expect(f.jain).toBeCloseTo((120 * 120) / (2 * (6400 + 1600)), 10);
  });

  it("núcleos usados = CPU ÷ relógio", () => {
    expect(coresUsed({ cpuMs: 500, wallMs: 1000 })).toBe(0.5);
    expect(coresUsed({ cpuMs: 5, wallMs: 0 })).toBe(0);
  });

  it("capacidade por núcleo vem do custo de CPU por envio, não da saturação do teste", () => {
    // 1,25 ms de CPU por envio a 80/s = 0,1 núcleo por número → 10 números por núcleo cheio, 7 com 70 % de folga.
    const c = capacityPerCore(1250, 1000, 80);
    expect(c.cpuMsPerSend).toBeCloseTo(1.25, 10);
    expect(c.numbersPerCoreFull).toBeCloseTo(10, 10);
    expect(c.numbersPerCoreSafe).toBeCloseTo(7, 10);
    expect(capacityPerCore(10, 0, 80).numbersPerCoreFull).toBe(0);
  });
});
