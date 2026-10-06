import { describe, expect, it } from "vitest";
import { STUCK_SENDING_MINUTES, stuckSendingCutoff, summarizeStuckSending } from "./stuck-sending";

describe("stuckSendingCutoff", () => {
  it("agora menos 3 minutos", () => {
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    expect(STUCK_SENDING_MINUTES).toBe(3);
    expect(stuckSendingCutoff(now)).toBe("2026-10-06T11:57:00.000Z");
  });
});

describe("summarizeStuckSending", () => {
  it("agrupa por campanha, maior primeiro", () => {
    expect(
      summarizeStuckSending([
        { campaign_id: "a", campaigns: { nome: "Cobrança A" } },
        { campaign_id: "b", campaigns: { nome: "Cobrança B" } },
        { campaign_id: "b", campaigns: { nome: "Cobrança B" } },
        { campaign_id: "c", campaigns: null },
      ])
    ).toEqual([
      { campaignId: "b", campaignName: "Cobrança B", count: 2 },
      { campaignId: "a", campaignName: "Cobrança A", count: 1 },
      { campaignId: "c", campaignName: "Campanha sem nome", count: 1 },
    ]);
  });
  it("vazio", () => {
    expect(summarizeStuckSending([])).toEqual([]);
  });
});
