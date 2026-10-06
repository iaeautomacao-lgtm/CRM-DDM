import { describe, expect, it } from "vitest";
import {
  CRON_BATCH_CANDIDATES_CEILING,
  MAX_CRON_BATCH_CANDIDATES,
  resolveCronCandidateCap,
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

describe("teto de candidatos derivado da vazão do tick", () => {
  it("nunca abaixo dos 700 de antes; cresce com vagas e orçamento; teto de 5.000", () => {
    expect(resolveCronCandidateCap({ globalConcurrency: 4, tickBudgetMs: 35_000 })).toBe(MAX_CRON_BATCH_CANDIDATES);
    expect(resolveCronCandidateCap({ globalConcurrency: 12, tickBudgetMs: 35_000 })).toBe(840);
    expect(resolveCronCandidateCap({ globalConcurrency: 48, tickBudgetMs: 45_000 })).toBe(4320);
    expect(resolveCronCandidateCap({ globalConcurrency: 50, tickBudgetMs: 50_000 })).toBe(CRON_BATCH_CANDIDATES_CEILING);
  });

  it("o batch_size da campanha continua limitando abaixo do teto", () => {
    expect(resolveCronBatchCandidateLimit(999_999, 4320)).toBe(4320);
    expect(resolveCronBatchCandidateLimit(614, 4320)).toBe(614);
    expect(resolveCronBatchCandidateLimit(null, 4320)).toBe(1);
  });
});
