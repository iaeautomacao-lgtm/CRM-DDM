import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingInflightColumn } from "@/lib/disparador/inflight-lease";
import { isMissingMarkerColumn, NOT_CALLED_SENTINEL } from "@/lib/disparador/provider-call-marker";

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
  /** Migration 332: '-infinity' = a chamada ao provedor nunca começou; timestamp = começou; NULL = anterior à migration. */
  provider_call_started_at?: string | null;
}

export interface StaleSendingRecovery {
  recoveredAccepted: number;
  finalizedUnknown: number;
  /** D-02: itens que NUNCA chegaram ao provedor (marcador '-infinity') e voltaram à fila para serem enviados. */
  requeuedNeverSent: number;
  failed: number;
  campaignIds: string[];
}

/**
 * Watchdog de reservas antigas em enviando.
 *
 * Com message id externo, o provedor confirmou aceite: tenta a RPC
 * idempotente normal e, se ela continuar falhando, faz um fallback local
 * para enviado. Sem message id:
 *  - marcador '-infinity' (migration 332): a chamada ao provedor NUNCA começou (processo morreu antes) → volta à fila, reenviar é
 *    seguro (D-02). O UPDATE exige o marcador ainda em '-infinity': se um remetente vivo gravou a chamada entre a leitura e aqui, não age;
 *  - marcador com timestamp ou NULL (linha anterior à migration): a chamada pode ter saído → erro permanente, NUNCA reenvia.
 */
export async function recoverStaleSendingReservations(
  db: SupabaseClient,
  now: Date = new Date(),
  minAgeMinutes: number = STALE_SENDING_MINUTES
): Promise<StaleSendingRecovery> {
  const cutoff = new Date(now.getTime() - Math.max(1, minAgeMinutes) * 60_000).toISOString();

  const staleQuery = (withLease: boolean, withMarker: boolean) => {
    let q = db
      .from("disp_message_queue")
      .select(
        "id,campaign_id,contact_id,session_id,mensagem_final,waha_message_id,tentativas,erro,sent_at,updated_at" +
          (withMarker ? ",provider_call_started_at" : "")
      )
      .eq("status", "enviando")
      .lt("updated_at", cutoff);
    // F14 (migration 194): item com lease VIVO (inflight_until no futuro) está sendo enviado agora — não é incerto.
    // Lease nulo = item sem lease (antigo/anterior à migration): tratado como sempre.
    if (withLease) q = q.or(`inflight_until.is.null,inflight_until.lt.${now.toISOString()}`);
    return q.limit(200);
  };
  let withMarker = true;
  let withLease = true;
  let { data, error } = await staleQuery(withLease, withMarker);
  // Sem a coluna do marcador (migration 332 ausente): comportamento anterior (tudo sem recibo é incerto).
  if (error && isMissingMarkerColumn(error)) {
    withMarker = false;
    ({ data, error } = await staleQuery(withLease, withMarker));
  }
  // Sem a coluna do lease (migration 194 ausente): comportamento anterior.
  if (error && isMissingInflightColumn(error)) {
    withLease = false;
    ({ data, error } = await staleQuery(withLease, withMarker));
  }

  if (error) throw error;

  const rows = (data ?? []) as unknown as StaleSendingRow[];
  if (!rows.length) {
    return { recoveredAccepted: 0, finalizedUnknown: 0, requeuedNeverSent: 0, failed: 0, campaignIds: [] };
  }

  let recoveredAccepted = 0;
  let finalizedUnknown = 0;
  let requeuedNeverSent = 0;
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

    // D-02: a chamada ao provedor nunca começou → nada saiu; volta à fila (sem gastar tentativa), só se o marcador ainda estiver assim.
    if (withMarker && row.provider_call_started_at === NOT_CALLED_SENTINEL) {
      const { data: requeued, error: requeueError } = await db
        .from("disp_message_queue")
        .update({ status: "agendado", inflight_until: null })
        .eq("id", row.id)
        .eq("status", "enviando")
        .is("waha_message_id", null)
        .eq("provider_call_started_at", NOT_CALLED_SENTINEL)
        .select("id");
      if (requeueError && withLease && isMissingInflightColumn(requeueError)) {
        // Sem a coluna do lease: devolve só o status.
        const retry = await db
          .from("disp_message_queue")
          .update({ status: "agendado" })
          .eq("id", row.id)
          .eq("status", "enviando")
          .is("waha_message_id", null)
          .eq("provider_call_started_at", NOT_CALLED_SENTINEL)
          .select("id");
        if (retry.error) failed++;
        else if ((retry.data?.length ?? 0) > 0) requeuedNeverSent++;
      } else if (requeueError) failed++;
      else if ((requeued?.length ?? 0) > 0) requeuedNeverSent++;
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
    requeuedNeverSent,
    failed,
    campaignIds: [...campaignIds],
  };
}
