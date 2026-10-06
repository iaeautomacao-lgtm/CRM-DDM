import { describe, expect, it } from "vitest";
import {
  MAX_CRON_BATCH_CANDIDATES,
  resolveCronBatchCandidateLimit,
  shouldReserveCampaignCadence,
} from "./cron-batching";

describe("disparador cron batching", () => {
  it("allows a segmented batch of 614 candidates in one cron tick", () => {
    expect(resolveCronBatchCandidateLimit(614)).toBe(614);
  });

  it("keeps a defensive upper bound of 700 for very large immediate campaigns", () => {
    expect(resolveCronBatchCandidateLimit(999999)).toBe(700);
    expect(MAX_CRON_BATCH_CANDIDATES).toBe(700);
  });

  it("keeps sequential campaigns on database cadence reservation", () => {
    expect(shouldReserveCampaignCadence(1)).toBe(true);
    expect(shouldReserveCampaignCadence(null)).toBe(true);
  });

  it("uses queue scheduled_at as cadence for batched campaigns", () => {
    expect(shouldReserveCampaignCadence(2)).toBe(false);
    expect(shouldReserveCampaignCadence(614)).toBe(false);
  });
});
