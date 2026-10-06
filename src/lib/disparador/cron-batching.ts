export const MAX_CRON_BATCH_CANDIDATES = 700;

export function resolveCronBatchCandidateLimit(batchSize: number | null | undefined): number {
  return Math.min(MAX_CRON_BATCH_CANDIDATES, Math.max(1, batchSize ?? 1));
}

export function shouldReserveCampaignCadence(batchSize: number | null | undefined): boolean {
  // batch_size=1 uses sequential pacing, so reserve_campaign_tick remains the
  // source of cadence between ticks. Batched/segmented campaigns already
  // encode the logical pause into each queue item's scheduled_at in
  // startCampaign.ts; reserving again would double-apply the pause and leave
  // most of a logical batch waiting after only one technical chunk.
  return (batchSize ?? 1) <= 1;
}
