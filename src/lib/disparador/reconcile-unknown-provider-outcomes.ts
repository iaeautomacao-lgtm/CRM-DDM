import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingInflightColumn } from "@/lib/disparador/inflight-lease";

export const STALE_SENDING_MINUTES = 2;

interface StaleSendingRow {
  id: string;
  campaign_id: string;
  contact_id: string | null;
  session_id: string | null;
  mensagem_final: string | null;
  waha_message_id: string | null;
  tentativas: number | null;
  erro: string | null;
  sent_at: string | null;
  updated_at: string | null;
}

export interface StaleSendingRecovery {
  recoveredAccepted: number;
  finalizedUnknown: number;
  failed: number;
  campaignIds: string[];
}

/**
 * Watchdog de reservas antigas em enviando.
 *
 * Com message id externo, o provedor confirmou aceite: tenta a RPC
 * idempotente normal e, se ela continuar falhando, faz um fallback local
 * para enviado. Sem message id, terminaliza como erro permanente e nunca
 * faz um segundo POST ao provedor.
 */
export async function recoverStaleSendingReservations(
  db: SupabaseClient,
  now: Date = new Date(),
  minAgeMinutes: number = STALE_SENDING_MINUTES
): Promise<StaleSendingRecovery> {
  const cutoff = new Date(now.getTime() - Math.max(1, minAgeMinutes) * 60_000).toISOString();

  const staleQuery = (withLease: boolean) => {
    let q = db
      .from("disp_message_queue")
      .select(
        "id,campaign_id,contact_id,session_id,mensagem_final,waha_message_id,tentativas,erro,sent_at,updated_at"
      )
      .eq("status", "enviando")
      .lt("updated_at", cutoff);
    // F14 (migration 194): item com lease VIVO (inflight_until no futuro) está sendo enviado agora — não é incerto.
    // Lease nulo = item sem lease (antigo/anterior à migration): tratado como sempre.
    if (withLease) q = q.or(`inflight_until.is.null,inflight_until.lt.${now.toISOString()}`);
    return q.limit(200);
  };
  let { data, error } = await staleQuery(true);
  // Sem a coluna (migration 194 ausente): comportamento anterior.
  if (error && isMissingInflightColumn(error)) ({ data, error } = await staleQuery(false));

  if (error) throw error;

  const rows = (data ?? []) as StaleSendingRow[];
  if (!rows.length) {
    return { recoveredAccepted: 0, finalizedUnknown: 0, failed: 0, campaignIds: [] };
  }

  let recoveredAccepted = 0;
  let finalizedUnknown = 0;
  let failed = 0;
  const campaignIds = new Set<string>();

  for (const row of rows) {
    campaignIds.add(row.campaign_id);

    if (row.waha_message_id) {
      const args = {
        p_item_id: row.id,
        p_campaign_id: row.campaign_id,
        p_contact_id: row.contact_id,
        p_session_id: row.session_id,
        p_mensagem: row.mensagem_final ?? "",
        p_waha_message_id: row.waha_message_id,
        p_tentativas: Math.max(1, row.tentativas ?? 0),
      };
      const confirmed = await db.rpc("confirm_dispatch_item_sent", args);
      if (!confirmed.error) {
        recoveredAccepted++;
        continue;
      }

      const { error: fallbackError } = await db
        .from("disp_message_queue")
        .update({
          status: "enviado",
          sent_at: row.sent_at ?? row.updated_at ?? now.toISOString(),
          tentativas: Math.max(1, row.tentativas ?? 0),
          erro: "Envio aceito pelo provedor; confirmação local recuperada pelo watchdog",
          erro_permanente: false,
        })
        .eq("id", row.id)
        .eq("status", "enviando")
        .eq("waha_message_id", row.waha_message_id);

      if (fallbackError) failed++;
      else recoveredAccepted++;
      continue;
    }

    const { error: finalizeError } = await db
      .from("disp_message_queue")
      .update({
        status: "erro",
        erro_permanente: true,
        tentativas: Math.max(1, row.tentativas ?? 0),
        erro: "Resultado externo não confirmado; encerrado sem reenvio para evitar duplicidade",
      })
      .eq("id", row.id)
      .eq("status", "enviando");

    if (finalizeError) failed++;
    else finalizedUnknown++;
  }

  for (const campaignId of campaignIds) {
    const { error: recalcError } = await db.rpc("recalculate_campaign_metrics", {
      p_campaign_id: campaignId,
    });
    if (recalcError) failed++;
  }

  return {
    recoveredAccepted,
    finalizedUnknown,
    failed,
    campaignIds: [...campaignIds],
  };
}
