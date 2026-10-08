// Número com qualidade VERMELHA (Meta): campanha nova (iniciar, "iniciar agora", retomar, agendada que venceu) exige confirmação do OWNER.
// Decisão do dono (P1-5). A regra mora aqui e é aplicada em startCampaign() — o único funil de início do dashboard e do cron de preparação —
// e na criação pela API v1 (que nunca confirma: chave de API não é o owner).
// Sem as tabelas da migration 190 (ou sem leitura) nada é bloqueado: inerte.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logAuditEvent } from "@/lib/audit/log-event";
import { redChannelsNeedingOwner } from "@/lib/disparador/rate-limits-service";

type Db = Pick<SupabaseClient, "from">;

export const RED_QUALITY_CODE = "red_quality_owner_required" as const;

export interface RedChannel {
  id: string;
  display_phone_number: string | null;
}

/** Confirmação já validada pelo CHAMADOR (papel owner + checkbox + motivo). */
export interface RedConfirmation {
  actorId: string;
  reason: string;
}

/** O corpo do request só vira confirmação se o autor é owner, marcou a caixa e deu motivo (≥ 3 caracteres). */
export function parseRedConfirmation(
  role: string | null | undefined,
  actorId: string | null | undefined,
  body: { confirm_red_quality?: unknown; red_quality_reason?: unknown } | null | undefined,
): RedConfirmation | undefined {
  if (role !== "owner" || !actorId || body?.confirm_red_quality !== true) return undefined;
  const reason = typeof body.red_quality_reason === "string" ? body.red_quality_reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) return undefined;
  return { actorId, reason };
}

export async function findRedChannels(db: Db, accountId: string, sessionIds: unknown): Promise<RedChannel[]> {
  const ids = Array.isArray(sessionIds) ? sessionIds.filter((s): s is string => typeof s === "string") : [];
  if (ids.length === 0) return [];
  const red = await redChannelsNeedingOwner(db, accountId, ids);
  if (red.length === 0) return [];
  const { data } = await db.from("whatsapp_config").select("id, display_phone_number").eq("account_id", accountId).in("id", red);
  const labels = new Map((data ?? []).map((r) => [String(r.id), (r.display_phone_number as string | null) ?? null]));
  return red.map((id) => ({ id, display_phone_number: labels.get(id) ?? null }));
}

export function redBlockedMessage(channels: RedChannel[]): string {
  const list = channels.map((c) => c.display_phone_number ?? c.id).join(", ");
  return `Número com qualidade vermelha na Meta (${list}): só o owner pode iniciar campanha nova nele, confirmando que está ciente.`;
}

/** Histórico (quem confirmou e por quê) + auditoria. Melhor esforço: falha aqui não derruba o início já autorizado. */
export async function recordRedConfirmation(
  db: Db,
  input: { accountId: string; campaignId: string; channels: RedChannel[]; confirmation: RedConfirmation },
): Promise<void> {
  const { accountId, campaignId, channels, confirmation } = input;
  try {
    await db.from("dispatch_channel_rate_history").insert(
      channels.map((c) => ({
        account_id: accountId,
        session_id: c.id,
        source: "admin",
        quality_old: "RED",
        quality_new: "RED",
        actor_id: confirmation.actorId,
        reason: confirmation.reason,
        detail: { red_start_confirmed: true, campaign_id: campaignId },
      })),
    );
  } catch (err) {
    console.error("[RedGate] Falha ao gravar o histórico da confirmação:", err instanceof Error ? err.message : err);
  }
  await logAuditEvent({
    accountId,
    eventType: "action",
    resourceType: "campaign",
    resourceId: campaignId,
    action: "campaign.red_quality_confirmed",
    summary: `Owner confirmou iniciar a campanha com número em qualidade vermelha (${channels.map((c) => c.display_phone_number ?? c.id).join(", ")}): ${confirmation.reason}`,
    metadata: { reason: confirmation.reason, session_ids: channels.map((c) => c.id), actor_id: confirmation.actorId },
  });
}
