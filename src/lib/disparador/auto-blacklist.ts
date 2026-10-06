import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { writeLog, maskPhone } from "@/lib/logger";
import { formatBrazilianPhone } from "@/lib/disparador/phone-key";

export const META_131026_CAMPAIGN_THRESHOLD = 3;

export interface Meta131026FailureResult {
  campaignCount: number;
  blacklisted: boolean;
}

/**
 * Registra uma ocorrência Meta 131026 para um telefone/campanha.
 *
 * A blacklist definitiva só é criada quando o mesmo número acumula
 * 131026 em 3 campanhas DISTINTAS. Repetições/retries dentro da mesma
 * campanha não aumentam o contador: a RPC usa UNIQUE por
 * (account_id, telefone, campaign_id).
 */
export async function autoBlacklistOn131026(
  rawPhone: string,
  campaignId: string | null,
): Promise<Meta131026FailureResult> {
  const telefone = formatBrazilianPhone(rawPhone);
  if (!telefone || !campaignId) {
    return { campaignCount: 0, blacklisted: false };
  }

  try {
    const db = supabaseAdmin();
    const { data: campaign, error: campaignError } = await db
      .from("campaigns")
      .select("account_id")
      .eq("id", campaignId)
      .maybeSingle();

    if (campaignError || !campaign?.account_id) {
      console.error(
        "[Disparador] autoBlacklistOn131026: falha ao resolver account_id da campanha:",
        campaignError,
      );
      return { campaignCount: 0, blacklisted: false };
    }

    const { data, error } = await db.rpc("record_meta_131026_failure", {
      p_account_id: campaign.account_id,
      p_telefone: telefone,
      p_campaign_id: campaignId,
    });

    if (error) {
      console.error(
        "[Disparador] autoBlacklistOn131026: falha ao registrar ocorrência:",
        error,
      );
      return { campaignCount: 0, blacklisted: false };
    }

    const row = Array.isArray(data) ? data[0] : data;
    const campaignCount = Number(row?.campaign_count ?? 0);
    const blacklisted = row?.blacklisted === true;

    void writeLog({
      account_id: campaign.account_id,
      level: blacklisted ? "warn" : "info",
      source: "disparador",
      event: blacklisted ? "blacklist_auto" : "meta_131026_strike",
      message: blacklisted
        ? `Número ${maskPhone(telefone)} adicionado definitivamente à blacklist após 131026 em ${campaignCount} campanhas distintas.`
        : `Número ${maskPhone(telefone)} registrou 131026 em ${campaignCount}/${META_131026_CAMPAIGN_THRESHOLD} campanhas distintas.`,
      payload: {
        campaign_id: campaignId,
        telefone_mascarado: maskPhone(telefone),
        code: 131026,
        campaign_count: campaignCount,
        threshold: META_131026_CAMPAIGN_THRESHOLD,
        blacklisted,
      },
    });

    return { campaignCount, blacklisted };
  } catch (err) {
    console.error("[Disparador] autoBlacklistOn131026: exceção inesperada:", err);
    return { campaignCount: 0, blacklisted: false };
  }
}
