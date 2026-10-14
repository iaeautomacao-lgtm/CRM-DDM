// Configuração do UTMpay por conta (wacrm.utmpay_config, migration 356) — lado SERVIDOR.
// A chave da API e o segredo do webhook ficam CIFRADOS (GCM) no banco e só voltam decifrados aqui, para o servidor falar com o UTMpay e
// conferir a assinatura dos eventos. Nunca vão para o cliente nem para o log.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tryDecrypt } from "@/lib/whatsapp/encryption";

type Db = Pick<SupabaseClient, "from">;

export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 7;

export interface UtmpayConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string | null;
  webhookSecret: string | null;
  janelaDias: number;
  /** Enviar o link cru se o UTMpay cair (padrão false: sem rastreio NÃO sai link, o item fica com erro claro). */
  sendWithoutTracking: boolean;
}

interface ConfigRow {
  enabled: boolean | null;
  base_url: string | null;
  api_key_enc: string | null;
  webhook_secret_enc: string | null;
  janela_dias: number | null;
  send_without_tracking: boolean | null;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: UtmpayConfig | null; expires: number }>();

/** Só para os testes e para quando a tela grava a configuração. */
export function resetUtmpayConfigCache(accountId?: string): void {
  if (accountId) cache.delete(accountId);
  else cache.clear();
}

export function utmpayConfigFromRow(row: ConfigRow | null): UtmpayConfig | null {
  if (!row?.base_url) return null;
  const decrypt = (v: string | null) => {
    if (!v) return null;
    try {
      return tryDecrypt(v) || null;
    } catch {
      return null; // chave de cifra trocada / linha corrompida: tratada como "sem chave"
    }
  };
  return {
    enabled: row.enabled !== false,
    baseUrl: row.base_url.replace(/\/+$/, ""),
    apiKey: decrypt(row.api_key_enc),
    webhookSecret: decrypt(row.webhook_secret_enc),
    janelaDias: row.janela_dias && row.janela_dias > 0 ? row.janela_dias : DEFAULT_ATTRIBUTION_WINDOW_DAYS,
    sendWithoutTracking: row.send_without_tracking === true,
  };
}

/** Config da conta, ou null (não configurada, migration 356 ausente ou erro de leitura). Cache curto: o envio lê por item. */
export async function loadUtmpayConfig(db: Db, accountId: string, now: number = Date.now()): Promise<UtmpayConfig | null> {
  const hit = cache.get(accountId);
  if (hit && hit.expires > now) return hit.value;
  let value: UtmpayConfig | null = null;
  try {
    const { data, error } = await db
      .from("utmpay_config")
      .select("enabled, base_url, api_key_enc, webhook_secret_enc, janela_dias, send_without_tracking")
      .eq("account_id", accountId)
      .maybeSingle();
    if (!error) value = utmpayConfigFromRow((data ?? null) as ConfigRow | null);
  } catch {
    value = null;
  }
  cache.set(accountId, { value, expires: now + CACHE_TTL_MS });
  return value;
}
