import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CAMPAIGN_CHANNEL_COLUMNS,
  campaignTemplateNames,
  validateCampaignConfig,
  type CampaignChannel,
  type CampaignConfigResult,
  type CampaignMessageFields,
  type TemplateMode,
} from "@/lib/disparador/campaign-validation";
import { flowPublishProblems } from "@/lib/disparador/flow-button";
import {
  TEMPLATE_VALIDATION_COLUMNS,
  type LocalTemplateRow,
} from "@/lib/disparador/template-validation";

// Carrega canais e catálogo de templates da conta e aplica as regras de
// campaign-validation.ts. Usado pelo PATCH da campanha e pelo
// startCampaign (mesma regra nos dois — e no assistente, que chama as
// funções puras direto).

export interface LoadedCampaignChannel extends CampaignChannel {
  display_phone_number?: string | null;
  waha_session?: string | null;
}

export type CampaignConfigCheck =
  | (Extract<CampaignConfigResult, { ok: true }> & { channels: LoadedCampaignChannel[] })
  | { ok: false; status: number; error: string };

export interface CampaignConfigCheckOptions {
  /** Modo de templates (dias_permitidos) — confere quantos templates/mensagens. */
  templateMode?: TemplateMode;
  /** campaigns.audience_mode — coluna do CSV só com base importada. */
  audienceMode?: string | null;
}

export async function checkCampaignConfig(
  db: SupabaseClient,
  accountId: string,
  sessionIds: readonly string[],
  mensagens: readonly CampaignMessageFields[],
  options: CampaignConfigCheckOptions = {}
): Promise<CampaignConfigCheck> {
  const ids = [...new Set(sessionIds.filter((id): id is string => typeof id === "string" && !!id))];
  let channels: LoadedCampaignChannel[] = [];
  if (ids.length > 0) {
    const { data, error } = await db
      .from("whatsapp_config")
      .select(CAMPAIGN_CHANNEL_COLUMNS)
      .in("id", ids)
      .eq("account_id", accountId);
    if (error) return { ok: false, status: 500, error: `Falha ao ler os canais: ${error.message}` };
    channels = ((data ?? []) as LoadedCampaignChannel[]).map((c) => ({
      ...c,
      label:
        c.provider === "meta"
          ? `número Meta ${c.display_phone_number ?? c.id}`
          : `sessão WAHA ${c.waha_session ?? c.id}`,
    }));
  }

  let templateRows: LocalTemplateRow[] = [];
  const names = campaignTemplateNames(mensagens);
  const isMeta = channels.some((c) => c.provider === "meta");
  if (isMeta && names.length > 0) {
    const { data, error } = await db
      .from("message_templates")
      .select(TEMPLATE_VALIDATION_COLUMNS)
      .eq("account_id", accountId)
      .in("name", names);
    if (error) {
      return { ok: false, status: 500, error: `Falha ao ler o catálogo de templates: ${error.message}` };
    }
    templateRows = (data ?? []) as LocalTemplateRow[];
  }

  const result = validateCampaignConfig({
    sessionIds: ids,
    channels,
    mensagens,
    templateRows,
    templateMode: options.templateMode,
    audienceMode: options.audienceMode,
  });
  if (!result.ok) return { ok: false, status: 400, error: result.error };
  // FLOW-03 (PRD 21.3): template com botão FLOW só entra se o Flow estiver PUBLISHED na Meta (confirmado na Graph API; sem confirmar, não começa)
  if (isMeta && templateRows.length > 0) {
    const metaChannels = channels.filter((c) => c.provider === "meta");
    const wabas = new Set(metaChannels.map((c) => c.waba_id).filter(Boolean));
    const ownRows = templateRows.filter((r) => !r.waba_id || wabas.has(r.waba_id)); // linha de outra WABA não vale
    const problems = await flowPublishProblems(db, accountId, metaChannels.map((c) => c.id), ownRows);
    if (problems.length > 0) return { ok: false, status: 400, error: problems[0] };
  }
  return { ...result, channels };
}
