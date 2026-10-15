// Lê do banco o que a conta guardou do UTMpay e devolve as credenciais em TEXTO (só no servidor), para o botão Conectar e a leitura da conexão.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { plainSecretFor } from "@/lib/utmpay/credentials";
import type { UtmpayConfigRow } from "@/lib/utmpay/config-api";

export const STORED_COLUMNS = "enabled, base_url, api_key_enc, webhook_secret_enc, janela_dias, send_without_tracking, updated_at";

export interface StoredCredentials {
  row: UtmpayConfigRow | null;
  baseUrl: string;
  apiKey: string | null;
  secret: string | null;
}

export type StoredLoad = { ok: true; value: StoredCredentials } | { ok: false; unavailable: boolean };

export async function loadStoredCredentials(db: Pick<SupabaseClient, "from">, accountId: string): Promise<StoredLoad> {
  const { data, error } = await db.from("utmpay_config").select(STORED_COLUMNS).eq("account_id", accountId).maybeSingle();
  if (error) return { ok: false, unavailable: error.code === "42P01" || error.code === "PGRST205" };
  const row = (data ?? null) as UtmpayConfigRow | null;
  return {
    ok: true,
    value: { row, baseUrl: row?.base_url ?? "", apiKey: plainSecretFor(undefined, row?.api_key_enc), secret: plainSecretFor(undefined, row?.webhook_secret_enc) },
  };
}
