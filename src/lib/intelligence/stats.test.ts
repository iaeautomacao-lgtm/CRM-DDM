import { describe, expect, it } from "vitest";
import { count, diff, mean, percentile, ratio } from "./stats";

describe("stats — contrato { value, numerator, denominator }", () => {
  it("ratio: value null sem denominador", () => {
    expect(ratio(1, 4)).toEqual({ value: 0.25, numerator: 1, denominator: 4 });
    expect(ratio(2, 3)).toEqual({ value: 0.6667, numerator: 2, denominator: 3 });
    expect(ratio(0, 0)).toEqual({ value: null, numerator: 0, denominator: 0 });
  });

  it("count", () => {
    expect(count(7)).toEqual({ value: 7, numerator: 7, denominator: 1 });
  });

  it("mean: soma no numerador, n no denominador", () => {
    expect(mean([5, 10, 60])).toEqual({ value: 25, numerator: 75, denominator: 3 });
    expect(mean([])).toEqual({ value: null, numerator: 0, denominator: 0 });
  });

  it("percentile nearest-rank: amostras ≤ valor no numerador", () => {
    expect(percentile([60, 5, 10], 90)).toEqual({ value: 60, numerator: 3, denominator: 3 });
    expect(percentile([50, 100, 300, 1000], 50, 0)).toEqual({ value: 100, numerator: 2, denominator: 4 });
    expect(percentile([], 50)).toEqual({ value: null, numerator: 0, denominator: 0 });
  });

  it("diff: absoluta e percentual; null quando falta amostra ou o anterior é 0", () => {
    const d = diff(ratio(3, 10), ratio(2, 10));
    expect(d.abs.value).toBe(0.1);
    expect(d.pct.value).toBe(0.5);
    expect(diff(count(5), count(0)).pct.value).toBeNull();
    expect(diff(ratio(1, 2), ratio(0, 0)).abs.value).toBeNull();
  });
});
