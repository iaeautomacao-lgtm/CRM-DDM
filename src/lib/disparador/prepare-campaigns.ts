// Preparação de campanhas agendadas FORA do tick de envio (B9).
//
// Antes, o /api/disparador/cron preparava (startCampaign) as campanhas
// `agendado` vencidas dentro do próprio tick: 50k contatos levam 1–3 min,
// 100k 2–6 min, e nesse tempo nenhuma campanha enviava. Agora a rota
// /api/disparador/prepare/cron faz isso, com lock próprio
// (`disparador_prepare`), e o tick só envia.
//
// DISPARADOR_PREPARE_IN_TICK (padrão true) mantém o comportamento antigo
// como fallback até o agendador externo chamar a rota nova; com `false` só a
// rota nova prepara.

import type { SupabaseClient } from "@supabase/supabase-js";
import { startCampaign, type StartCampaignResult } from "@/lib/disparador/startCampaign";

/** Campanha em 'preparando' sem updated_at há tanto tempo é considerada presa (crash). */
export const PREPARING_STUCK_MS = 30 * 60_000;
/** Máximo de campanhas vencidas lidas por rodada. */
export const PREPARE_BATCH_LIMIT = 20;

/** O tick de envio ainda prepara campanhas? Padrão sim (fallback até o cron novo existir). */
export function isPrepareInTickEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DISPARADOR_PREPARE_IN_TICK ?? "").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(raw);
}

/**
 * Campanha presa em 'preparando' (processo caiu no meio do startCampaign — o
 * finally não roda num crash): depois de 30 min sem updated_at volta para
 * 'agendado' se tiver agendamento (o próximo ciclo tenta de novo, sem perder
 * a data) ou 'rascunho' se não tiver. Os itens parciais não são consumidos
 * (campanha fora de execução) e o próximo start limpa a fila antes de publicar.
 */
export async function recoverStuckPreparing(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ toAgendado: number; toRascunho: number }> {
  const stuckBefore = new Date(now.getTime() - PREPARING_STUCK_MS).toISOString();
  const stamp = now.toISOString();
  const withSchedule = await db
    .from("campaigns")
    .update({ status: "agendado", updated_at: stamp })
    .eq("status", "preparando")
    .lt("updated_at", stuckBefore)
    .not("agendamento", "is", null)
    .select("id");
  if (withSchedule.error) {
    console.error("[Prepare] Falha ao devolver campanhas presas para 'agendado':", withSchedule.error.message);
  }
  const withoutSchedule = await db
    .from("campaigns")
    .update({ status: "rascunho", updated_at: stamp })
    .eq("status", "preparando")
    .lt("updated_at", stuckBefore)
    .is("agendamento", null)
    .select("id");
  if (withoutSchedule.error) {
    console.error("[Prepare] Falha ao devolver campanhas presas para 'rascunho':", withoutSchedule.error.message);
  }
  return {
    toAgendado: withSchedule.data?.length ?? 0,
    toRascunho: withoutSchedule.data?.length ?? 0,
  };
}

export interface PrepareReport {
  attempted: number;
  prepared: number;
  failed: number;
  results: Array<{ campaignId: string; ok: boolean; enqueued?: number; error?: string }>;
}

/**
 * Prepara as campanhas `agendado` vencidas, UMA POR VEZ, parando quando o
 * orçamento de tempo acaba (checado antes de cada campanha; uma preparação
 * em curso não é interrompida).
 */
export async function prepareDueCampaigns(
  db: SupabaseClient,
  options: {
    outOfTime: () => boolean;
    start?: (campaignId: string, accountId: string) => Promise<StartCampaignResult>;
    now?: Date;
  },
): Promise<PrepareReport> {
  const start = options.start ?? ((id: string, account: string) => startCampaign(id, account));
  const report: PrepareReport = { attempted: 0, prepared: 0, failed: 0, results: [] };
  const { data: due, error } = await db
    .from("campaigns")
    .select("id, account_id")
    .eq("status", "agendado")
    .lte("agendamento", (options.now ?? new Date()).toISOString())
    .order("agendamento", { ascending: true })
    .limit(PREPARE_BATCH_LIMIT);
  if (error) throw error;

  for (const campaign of due ?? []) {
    if (options.outOfTime()) break;
    if (!campaign.account_id) continue;
    report.attempted++;
    const result = await start(campaign.id, campaign.account_id);
    if (result.ok) {
      report.prepared++;
      report.results.push({ campaignId: campaign.id, ok: true, enqueued: result.enqueued });
    } else {
      report.failed++;
      report.results.push({ campaignId: campaign.id, ok: false, error: result.error });
      console.error("[Prepare] Falha ao preparar campanha:", campaign.id, result.error);
    }
  }
  return report;
}
