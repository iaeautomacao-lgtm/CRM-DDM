// Marcador "chamada ao provedor iniciada" (AUDIT-DISPARADOR D-02 / migration 332).
//
// Problema: num restart do Passenger no meio do tick, todo item `enviando` sem recibo virava "erro permanente — resultado externo não
// confirmado", inclusive os que NUNCA chegaram ao provedor. Agora o item carrega, em disp_message_queue.provider_call_started_at:
//
//   '-infinity'  reivindicado (o trigger da migration 332 grava no claim) e a chamada ao provedor AINDA NÃO começou
//                → se o processo morrer aqui, é seguro devolver o item à fila (nada saiu);
//   timestamp    a chamada começou (gravado IMEDIATAMENTE antes do POST à Meta ou à WAHA)
//                → se o processo morrer, o resultado é incerto: erro permanente, NUNCA reenviar (regra de sempre);
//   NULL         linha reivindicada antes da migration (ou coluna ausente): comportamento antigo (incerto).
//
// O marcador é também uma TRAVA de exclusão (compare-and-set): só um remetente consegue passar de ('-infinity'|NULL) para um timestamp
// por reivindicação. Dois remetentes do mesmo item (um lento que o watchdog devolveu à fila e o novo que o reivindicou) nunca fazem
// duas chamadas: o segundo recebe "lost" e não envia.
//
// Sem a coluna (42703/PGRST204) tudo segue como antes; a detecção é reavaliada a cada 5 min (o restart pós-migration não é obrigatório).

import type { SupabaseClient } from "@supabase/supabase-js";

export const NOT_CALLED_SENTINEL = "-infinity";
const RECHECK_MISSING_COLUMN_MS = 5 * 60_000;

let columnMissingSince: number | null = null;

/** Só para testes. */
export function resetProviderCallMarkerState(): void {
  columnMissingSince = null;
}

export function isMissingMarkerColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /provider_call_started_at/i.test(error.message ?? ""));
}

export type MarkResult =
  /** Marcado: este remetente é o único autorizado a chamar o provedor. */
  | "marked"
  /** Outro remetente já chamou, ou o item não está mais `enviando` (devolvido à fila/encerrado): NÃO enviar. */
  | "lost"
  /** Coluna ausente (migration 332 não aplicada): seguir como antes, sem marcador. */
  | "unavailable"
  /** Falha de leitura/escrita: não dá para provar o estado; NÃO enviar (o item volta à fila). */
  | "error";

/**
 * Compare-and-set imediatamente ANTES da chamada ao provedor. Nunca lança.
 * Aceita ('-infinity' | NULL): NULL é a linha reivindicada antes da migration.
 */
export async function markProviderCallStarted(
  db: Pick<SupabaseClient, "from">,
  itemId: string,
  now: () => number = Date.now,
): Promise<MarkResult> {
  if (columnMissingSince !== null && now() - columnMissingSince < RECHECK_MISSING_COLUMN_MS) return "unavailable";
  try {
    const { data, error } = await db
      .from("disp_message_queue")
      .update({ provider_call_started_at: new Date(now()).toISOString() })
      .eq("id", itemId)
      .eq("status", "enviando")
      .or(`provider_call_started_at.is.null,provider_call_started_at.eq.${NOT_CALLED_SENTINEL}`)
      .select("id");
    if (error) {
      if (isMissingMarkerColumn(error)) {
        columnMissingSince = now();
        return "unavailable";
      }
      console.error("[Disparador] Falha ao gravar o marcador de chamada ao provedor:", error.message);
      return "error";
    }
    columnMissingSince = null;
    return Array.isArray(data) && data.length > 0 ? "marked" : "lost";
  } catch (err) {
    console.error("[Disparador] Falha ao gravar o marcador de chamada ao provedor:", err instanceof Error ? err.message : err);
    return "error";
  }
}

/**
 * Devolve à fila um item reivindicado que NÃO chegou ao provedor (marcador ainda em '-infinity'/NULL). Só age nesse estado: se a
 * chamada já começou, não toca. Best-effort (o watchdog também recupera). Devolve se voltou.
 */
export async function releaseUncalledItem(db: Pick<SupabaseClient, "from">, itemId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("disp_message_queue")
      .update({ status: "agendado", inflight_until: null })
      .eq("id", itemId)
      .eq("status", "enviando")
      .or(`provider_call_started_at.is.null,provider_call_started_at.eq.${NOT_CALLED_SENTINEL}`)
      .select("id");
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}
