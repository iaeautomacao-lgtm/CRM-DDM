import { describe, expect, it } from "vitest";
import { buildLivePerformanceSnapshot } from "./live-performance";

describe("buildLivePerformanceSnapshot", () => {
  it("soma fila pendente + enviando como restante", () => {
    expect(
      buildLivePerformanceSnapshot({
        sampledAt: "2026-10-07T18:00:00.000Z",
        activeCampaigns: 2,
        queued: 900,
        sending: 24,
        errors: 3,
        blocked: 1,
        sentLast60s: 1250,
      })
    ).toEqual({
      sampledAt: "2026-10-07T18:00:00.000Z",
      activeCampaigns: 2,
      queued: 900,
      sending: 24,
      errors: 3,
      blocked: 1,
      remaining: 924,
      sentLast60s: 1250,
    });
  });

  it("normaliza contagens ausentes ou negativas sem inventar trabalho", () => {
    const result = buildLivePerformanceSnapshot({
      sampledAt: "2026-10-07T18:00:00.000Z",
      activeCampaigns: -1,
      queued: null,
      sending: -4,
      errors: undefined,
      blocked: null,
      sentLast60s: -10,
    });
    expect(result.activeCampaigns).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.sentLast60s).toBe(0);
  });
});
