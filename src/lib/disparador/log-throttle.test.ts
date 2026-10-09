import { beforeEach, describe, expect, it } from "vitest";
import { LOG_THROTTLE_WINDOW_MS, resetLogThrottleForTests, throttleItemLog } from "./log-throttle";

beforeEach(resetLogThrottleForTests);

describe("throttleItemLog (F12)", () => {
  it("grava o 1º e suprime o resto da janela; o próximo registro informa quantos foram omitidos", () => {
    expect(throttleItemLog("c1", "message_permanent_error", 190, 0)).toEqual({ log: true, suppressed: 0 });
    for (let i = 1; i <= 500; i++) expect(throttleItemLog("c1", "message_permanent_error", 190, i)).toEqual({ log: false });
    expect(throttleItemLog("c1", "message_permanent_error", 190, LOG_THROTTLE_WINDOW_MS)).toEqual({ log: true, suppressed: 500 });
  });

  it("campanha, evento e código diferentes têm janelas independentes", () => {
    expect(throttleItemLog("c1", "e", 190, 0).log).toBe(true);
    expect(throttleItemLog("c2", "e", 190, 1).log).toBe(true);
    expect(throttleItemLog("c1", "f", 190, 2).log).toBe(true);
    expect(throttleItemLog("c1", "e", 131026, 3).log).toBe(true);
    expect(throttleItemLog("c1", "e", 190, 4).log).toBe(false);
  });
});
