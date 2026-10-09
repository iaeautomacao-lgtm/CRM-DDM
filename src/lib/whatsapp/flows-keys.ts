import "server-only";
// PRD 21, PR 21.2 — par RSA do Data Exchange por canal (wacrm.whatsapp_flows_keys, migration 291; fechada, só service role).
// A privada é cifrada com a chave AES da plataforma (encrypt, GCM) e NUNCA sai do servidor; a pública é o que se mostra/envia à Meta.
import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import { generateFlowsKeyPair } from "./flows-crypto";

type Db = Pick<SupabaseClient, "from">;

export interface FlowsKeyInfo {
  configured: boolean;
  public_key: string | null;
  created_at: string | null;
  rotated_at: string | null;
}

export class FlowsKeysUnavailableError extends Error {
  constructor() {
    super("Chaves dos WhatsApp Flows indisponíveis: aplique a migration 291");
    this.name = "FlowsKeysUnavailableError";
  }
}

const isMissingTable = (e: { code?: string }) => e.code === "42P01" || e.code === "PGRST205";

export async function getFlowsKeyInfo(db: Db, accountId: string, channelId: string): Promise<FlowsKeyInfo> {
  const { data, error } = await db
    .from("whatsapp_flows_keys")
    .select("public_key, created_at, rotated_at")
    .eq("account_id", accountId)
    .eq("channel_id", channelId)
    .limit(1);
  if (error) {
    if (isMissingTable(error)) throw new FlowsKeysUnavailableError();
    throw error;
  }
  const row = (data as Array<{ public_key: string; created_at: string; rotated_at: string | null }> | null)?.[0];
  return row ? { configured: true, public_key: row.public_key, created_at: row.created_at, rotated_at: row.rotated_at } : { configured: false, public_key: null, created_at: null, rotated_at: null };
}

/** Gera o par se o canal ainda não tem; `rotate` troca por um novo (a pública antiga deixa de valer assim que a nova for registrada na Meta). */
export async function ensureFlowsKeys(db: Db, accountId: string, channelId: string, options: { rotate?: boolean } = {}): Promise<FlowsKeyInfo & { created: boolean }> {
  const existing = await getFlowsKeyInfo(db, accountId, channelId);
  if (existing.configured && !options.rotate) return { ...existing, created: false };

  const { publicKeyPem, privateKeyPem } = generateFlowsKeyPair();
  const privateEnc = encrypt(privateKeyPem);
  const now = new Date().toISOString();
  const { error } = existing.configured
    ? await db.from("whatsapp_flows_keys").update({ public_key: publicKeyPem, private_key_enc: privateEnc, rotated_at: now }).eq("account_id", accountId).eq("channel_id", channelId)
    : await db.from("whatsapp_flows_keys").insert({ channel_id: channelId, account_id: accountId, public_key: publicKeyPem, private_key_enc: privateEnc });
  if (error) {
    if (isMissingTable(error)) throw new FlowsKeysUnavailableError();
    throw error;
  }
  return { configured: true, public_key: publicKeyPem, created_at: existing.created_at ?? now, rotated_at: existing.configured ? now : null, created: !existing.configured };
}

/** PEM da chave privada do canal (decifrada só em memória) ou null se o canal não tem chave. */
export async function loadFlowsPrivateKey(db: Db, channelId: string): Promise<string | null> {
  const { data, error } = await db.from("whatsapp_flows_keys").select("private_key_enc").eq("channel_id", channelId).limit(1);
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  const enc = (data as Array<{ private_key_enc: string }> | null)?.[0]?.private_key_enc;
  return enc ? decrypt(enc) : null;
}
