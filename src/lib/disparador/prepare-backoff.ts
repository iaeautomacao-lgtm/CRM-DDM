// Backoff da PREPARAÇÃO de campanha agendada (PRD 11, A3 / migration 196).
//
// Antes: uma campanha agendada cuja preparação falhava por erro transitório (5xx do banco, exceção) voltava a `agendado` e era
// retentada TODO minuto — cada tentativa apaga/remonta a fila e relê o público, carga inútil no banco justamente quando ele está
// mal. Agora cada falha adia a próxima tentativa: 1, 2, 4, 8, 16, 30, 30… minutos (teto 30); o motivo e o número da tentativa ficam
// em campaigns.motivo_falha_inicio (visível no card) e, na 5ª falha seguida (e a cada 10 depois), um alerta vai para o feed do Monitor.
// Não muda quem entra na campanha nem o que é enviado: só QUANDO a preparação tenta de novo.
//
// Tolerante à migration 196 ausente (colunas prepare_attempts/next_prepare_at): sem elas só o motivo é gravado e o retry segue
// no ritmo de antes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeLog } from "@/lib/logger";
import { formatBrasilia } from "@/lib/disparador/send-window";

export const PREPARE_BACKOFF_BASE_MINUTES = 1;
export const PREPARE_BACKOFF_MAX_MINUTES = 30;
/** 5ª falha seguida: alerta no Monitor (e depois a cada 10). */
export const PREPARE_ALERT_AFTER = 5;
export const PREPARE_ALERT_EVERY = 10;

/** Espera, em minutos, depois da falha número `attempts` (1-based): 1, 2, 4, 8, 16, 30, 30… */
export function prepareBackoffMinutes(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(PREPARE_BACKOFF_MAX_MINUTES, PREPARE_BACKOFF_BASE_MINUTES * 2 ** (n - 1));
}

export function shouldAlertPrepare(attempts: number): boolean {
  return attempts === PREPARE_ALERT_AFTER || (attempts > PREPARE_ALERT_AFTER && (attempts - PREPARE_ALERT_AFTER) % PREPARE_ALERT_EVERY === 0);
}

export function formatPrepareRetryReason(error: string, agendamento: string | null, attempts: number, delayMinutes: number): string {
  const quando = agendamento ? ` agendada para ${formatBrasilia(agendamento)} (Brasília)` : "";
  return `A preparação da campanha${quando} falhou (tentativa ${attempts}); nova tentativa em ${delayMinutes} min: ${error.trim() || "erro desconhecido"}`.slice(0, 1000);
}

function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /prepare_attempts|next_prepare_at/.test(error.message ?? ""));
}

/**
 * Registra uma falha RETENTÁVEL da preparação: sobe prepare_attempts, define next_prepare_at com o backoff e grava o motivo.
 * Nunca lança. Devolve o estado registrado (para testes/log).
 */
export async function recordPrepareRetry(
  db: SupabaseClient,
  args: { campaignId: string; accountId: string; agendamento: string | null; error: string; now?: Date },
): Promise<{ attempts: number; delayMinutes: number } | null> {
  const now = args.now ?? new Date();
  try {
    const read = await db.from("campaigns").select("prepare_attempts").eq("id", args.campaignId).eq("account_id", args.accountId).limit(1);
    const hasColumns = !read.error;
    const attempts = (hasColumns ? Number((read.data?.[0] as { prepare_attempts?: number } | undefined)?.prepare_attempts ?? 0) : 0) + 1;
    const delayMinutes = prepareBackoffMinutes(attempts);
    const motivo = formatPrepareRetryReason(args.error, args.agendamento, attempts, delayMinutes);

    let update = await db
      .from("campaigns")
      .update(hasColumns ? { motivo_falha_inicio: motivo, prepare_attempts: attempts, next_prepare_at: new Date(now.getTime() + delayMinutes * 60_000).toISOString() } : { motivo_falha_inicio: motivo })
      .eq("id", args.campaignId)
      .eq("account_id", args.accountId);
    if (update.error && hasColumns && isMissingColumn(update.error)) {
      update = await db.from("campaigns").update({ motivo_falha_inicio: motivo }).eq("id", args.campaignId).eq("account_id", args.accountId);
    }
    if (update.error) console.error("[Prepare] Falha ao registrar o backoff da preparação:", update.error.message);

    if (shouldAlertPrepare(attempts)) {
      void writeLog({
        account_id: args.accountId,
        level: "error",
        source: "disparador",
        event: "campaign_prepare_alert",
        message: `A campanha não consegue ser preparada: ${attempts} falhas seguidas (próxima tentativa em ${delayMinutes} min). ${args.error.trim()}`.slice(0, 1000),
        payload: { campaign_id: args.campaignId, attempts, next_attempt_in_minutes: delayMinutes, error: args.error.slice(0, 300) },
      });
    }
    return { attempts, delayMinutes };
  } catch (err) {
    console.error("[Prepare] Falha ao registrar o backoff da preparação:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Preparação deu certo (ou a campanha saiu do agendamento): zera o backoff. Tolerante à migration ausente. */
export async function resetPrepareBackoff(db: SupabaseClient, campaignId: string): Promise<void> {
  try {
    const { error } = await db
      .from("campaigns")
      .update({ prepare_attempts: 0, next_prepare_at: null })
      .eq("id", campaignId)
      .gt("prepare_attempts", 0);
    if (error && !isMissingColumn(error)) console.error("[Prepare] Falha ao zerar o backoff da preparação:", error.message);
  } catch (err) {
    // Best-effort: zerar o contador nunca pode derrubar o início/retomada da campanha.
    console.error("[Prepare] Falha ao zerar o backoff da preparação:", err instanceof Error ? err.message : err);
  }
}
