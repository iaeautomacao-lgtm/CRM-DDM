// Disparador × UTMpay: TODO disparo sai rastreado (sem opt-in), quando a conta tem o UTMpay configurado (decisão do dono, 14/10).
// A operação informa o link que quer (campanha/planilha); aqui ele vira o DESTINO de um link rastreado do UTMpay, um por envio (tid = id do item).
// WAHA (texto livre) e Meta (variável {{n}} do template) são caminhos SEPARADOS e nunca se unificam: cada um tem a sua função.
// Se o UTMpay falhar, o link cru NÃO sai em silêncio: o resultado é `failed` e o item fica com erro claro, a não ser que a conta tenha marcado
// "enviar sem rastreio se o UTMpay cair" (aí segue o original e o aviso vai para o log).
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadUtmpayConfig, type UtmpayConfig } from "@/lib/utmpay/config";
import { ensureTrackedLink, type LinkDeps } from "@/lib/utmpay/links";
import { findFirstUrl, findFirstUrlInVariables, replaceFoundUrl } from "@/lib/utmpay/urls";

type Db = Pick<SupabaseClient, "from">;

export const UTMPAY_UNAVAILABLE_ERROR = "Rastreamento (UTMpay) indisponível; nada foi enviado ao cliente e o item será tentado novamente";

export interface DispatchItem {
  id: string;
  campaign_id: string;
  contact_id: string | null;
}

export type TrackedText = { kind: "unchanged" } | { kind: "tracked"; text: string } | { kind: "failed" };
export type TrackedVariables = { kind: "unchanged" } | { kind: "tracked"; variables: string[] } | { kind: "failed" };

const nameCache = new Map<string, { name: string; expires: number }>();
const NAME_TTL_MS = 5 * 60_000;

/** Só para os testes. */
export function resetCampaignNameCache(): void {
  nameCache.clear();
}

async function campaignName(db: Db, accountId: string, campaignId: string, now = Date.now()): Promise<string> {
  const hit = nameCache.get(campaignId);
  if (hit && hit.expires > now) return hit.name;
  let name = campaignId;
  try {
    const { data } = await db.from("campaigns").select("nome").eq("id", campaignId).eq("account_id", accountId).maybeSingle();
    const nome = (data as { nome?: string } | null)?.nome?.trim();
    if (nome) name = nome;
  } catch {
    // mantém o id como nome da campanha no UTMpay
  }
  nameCache.set(campaignId, { name, expires: now + NAME_TTL_MS });
  return name;
}

function failure(config: UtmpayConfig, err: unknown): "failed" | "unchanged" {
  console.error("[utmpay] link rastreado indisponível:", err instanceof Error ? err.message.slice(0, 120) : "erro");
  return config.sendWithoutTracking ? "unchanged" : "failed";
}

async function activeConfig(db: Db, accountId: string): Promise<UtmpayConfig | null> {
  const config = await loadUtmpayConfig(db, accountId);
  return config && config.enabled && config.apiKey ? config : null;
}

/** WAHA e Meta fora de template (texto livre / legenda): troca a primeira URL do texto final pelo link rastreado. */
export async function trackDispatchText(db: Db, accountId: string, item: DispatchItem, text: string, deps: LinkDeps = {}): Promise<TrackedText> {
  const config = await activeConfig(db, accountId);
  if (!config) return { kind: "unchanged" };
  const found = findFirstUrl(text);
  if (!found) return { kind: "unchanged" };
  try {
    const link = await ensureTrackedLink(
      db,
      accountId,
      config,
      { tid: item.id, campaignId: item.campaign_id, campanha: await campaignName(db, accountId, item.campaign_id), contactId: item.contact_id, destino: found.url },
      deps,
    );
    return { kind: "tracked", text: replaceFoundUrl(text, found, link.linkCurto) };
  } catch (err) {
    return { kind: failure(config, err) };
  }
}

/** Meta com template: troca a primeira URL entre as VARIÁVEIS do corpo ({{n}}); o texto aprovado do template não é tocado. */
export async function trackDispatchVariables(db: Db, accountId: string, item: DispatchItem, variables: readonly string[], deps: LinkDeps = {}): Promise<TrackedVariables> {
  const config = await activeConfig(db, accountId);
  if (!config) return { kind: "unchanged" };
  const hit = findFirstUrlInVariables(variables);
  if (!hit) return { kind: "unchanged" };
  try {
    const link = await ensureTrackedLink(
      db,
      accountId,
      config,
      { tid: item.id, campaignId: item.campaign_id, campanha: await campaignName(db, accountId, item.campaign_id), contactId: item.contact_id, destino: hit.found.url },
      deps,
    );
    const next = [...variables];
    next[hit.index] = replaceFoundUrl(String(variables[hit.index]), hit.found, link.linkCurto);
    return { kind: "tracked", variables: next };
  } catch (err) {
    return { kind: failure(config, err) };
  }
}
