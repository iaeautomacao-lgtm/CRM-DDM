import { supabaseAdmin } from "@/lib/flows/admin-client";
import { encrypt } from "@/lib/whatsapp/encryption";
import type { SocialChannelType } from "./graph";
import type { ConnectedAccount } from "./oauth";

// Gravação dos canais conectados por OAuth e leitura "segura" (sem token)
// para a UI. Toda escrita passa pelo service role: a tabela channels não
// tem acesso direto do navegador (migration 128).

/** Campos que podem ir ao navegador (sem access_token). */
export const PUBLIC_CHANNEL_COLUMNS =
  "id, type, name, external_id, username, avatar_url, team_id, flow_id, client_id, habilitado, status, last_error, token_expires_at, created_at";

export async function saveConnectedChannels(
  accountId: string,
  userId: string,
  type: SocialChannelType,
  accounts: ConnectedAccount[],
): Promise<{ saved: number; conflicts: string[] }> {
  const db = supabaseAdmin();
  let saved = 0;
  const conflicts: string[] = [];
  for (const acc of accounts) {
    const { data: existing } = await db
      .from("channels")
      .select("id, account_id")
      .eq("type", type)
      .eq("external_id", acc.externalId)
      .limit(1);
    const row = existing?.[0];
    // Um perfil/página só pode estar numa conta: o webhook resolve a conta
    // pelo external_id.
    if (row && row.account_id !== accountId) {
      conflicts.push(acc.name);
      continue;
    }
    const values = {
      name: acc.name,
      username: acc.username,
      avatar_url: acc.avatarUrl,
      access_token: encrypt(acc.accessToken),
      token_expires_at: acc.expiresAt,
      status: "connected",
      last_error: null,
      connected_by: userId,
      updated_at: new Date().toISOString(),
    };
    const { error } = row
      ? await db.from("channels").update(values).eq("id", row.id)
      : await db.from("channels").insert({
          ...values,
          account_id: accountId,
          type,
          external_id: acc.externalId,
        });
    if (error) throw new Error(`channel save failed: ${error.message}`);
    saved++;
  }
  return { saved, conflicts };
}
