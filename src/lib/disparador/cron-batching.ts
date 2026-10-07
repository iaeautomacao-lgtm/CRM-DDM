/**
 * Piso do teto de candidatos por campanha por tick (era o teto fixo). Com os
 * botões de vazão padrão o teto derivado fica um pouco acima dele.
 */
export const MAX_CRON_BATCH_CANDIDATES = 700;
/** Teto absoluto (memória: o select embute contacts, ~1 KB por linha). */
export const CRON_BATCH_CANDIDATES_CEILING = 5000;
/** Tempo otimista por envio usado para não faltar candidato no tick. */
const OPTIMISTIC_SECONDS_PER_ITEM = 0.5;

/**
 * Teto de candidatos por campanha por tick derivado da vazão máxima do tick:
 * uma campanha nunca envia mais que concorrência global × orçamento ÷ tempo
 * por envio. Antes era fixo em 700 e segurava a campanha (somando todos os
 * números dela) em 700 envios por tick, por mais vagas que houvesse.
 * Ex.: 12 vagas × 35 s ÷ 0,5 s = 840; 48 × 45 s ÷ 0,5 s = 4.320.
 */
export function resolveCronCandidateCap(config: { globalConcurrency: number; tickBudgetMs: number }): number {
  const byTime = Math.ceil(
    (Math.max(1, config.globalConcurrency) * Math.max(0, config.tickBudgetMs)) / (OPTIMISTIC_SECONDS_PER_ITEM * 1000)
  );
  return Math.min(CRON_BATCH_CANDIDATES_CEILING, Math.max(MAX_CRON_BATCH_CANDIDATES, byTime));
}

export function resolveCronBatchCandidateLimit(
  batchSize: number | null | undefined,
  cap: number = MAX_CRON_BATCH_CANDIDATES
): number {
  return Math.min(cap, Math.max(1, batchSize ?? 1));
}

export function shouldReserveCampaignCadence(batchSize: number | null | undefined): boolean {
  // batch_size=1 uses sequential pacing, so reserve_campaign_tick remains the
  // source of cadence between ticks. Batched/segmented campaigns already
  // encode the logical pause into each queue item's scheduled_at in
  // startCampaign.ts; reserving again would double-apply the pause and leave
  // most of a logical batch waiting after only one technical chunk.
  return (batchSize ?? 1) <= 1;
}
