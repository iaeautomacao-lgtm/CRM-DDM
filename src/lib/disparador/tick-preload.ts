// Dados carregados UMA vez por tick do cron e reaproveitados por todos os
// envios do tick (antes: 1 select por envio para cada um).
//
// - Blacklist: revalidação de todos os candidatos numa RPC
//   (wacrm.blacklisted_phone_keys, migration 167), pela mesma chave do
//   startCampaign (phoneKey). Pode ter até 1 tick (≤ 60 s) de atraso em
//   relação a um bloqueio feito agora; o startCampaign já filtra a
//   blacklist na montagem da fila, isto é só a revalidação.
// - Sem a RPC (migration não aplicada) ou com erro, a função devolve
//   undefined e cada envio consulta o banco como antes (falha fechada lá).

import type { SupabaseClient } from "@supabase/supabase-js";
import { phoneKey } from "@/lib/disparador/phone-key";

/** Resposta da blacklist pré-carregada: undefined = não carregado (consultar). */
export type BlacklistLookup = (phone: string) => boolean | undefined;

/** Chaves por chamada (a resposta também respeita o max-rows do PostgREST). */
export const BLACKLIST_PRELOAD_CHUNK = 1000;

/**
 * Telefone que o envio usa sem consulta extra: o principal do contato ou o
 * externo (mensagem_final). null quando o item está na escada de telefones
 * alternativos (phone_attempt_order > 1), que é lido de contact_phones.
 */
export function queueItemPrimaryPhone(item: {
  contact_id: string | null;
  mensagem_final: string;
  phone_attempt_order?: number;
  contacts?: { phone?: string };
}): string | null {
  if (item.contact_id) {
    if ((item.phone_attempt_order ?? 1) > 1) return null;
    // Contato do CRM: só o telefone do contato. mensagem_final é o TEXTO da mensagem
    // (nunca vira telefone); só itens externos (contact_id nulo) guardam o número ali.
    return item.contacts?.phone || null;
  }
  return item.mensagem_final || null;
}

/**
 * Canal do item para processQueueItem a partir das linhas de whatsapp_config
 * lidas no tick, com o mesmo filtro de conta da leitura por envio:
 * null = não existe / não é da conta da campanha; undefined = a leitura do
 * tick falhou (o envio lê sozinho).
 */
export function channelConfigFor(
  configs: ReadonlyMap<string, Record<string, any>> | null,
  channelId: string,
  accountId: string | undefined
): Record<string, any> | null | undefined {
  if (!configs) return undefined;
  const row = configs.get(channelId);
  if (!row) return null;
  if (accountId && row.account_id !== accountId) return null;
  return row;
}

export async function preloadBlacklist(
  db: SupabaseClient,
  phones: Iterable<string | null>
): Promise<BlacklistLookup | undefined> {
  const keys = new Set<string>();
  for (const phone of phones) {
    const key = phone ? phoneKey(phone) : "";
    if (key) keys.add(key);
  }
  if (!keys.size) return undefined;
  const all = [...keys];
  const blocked = new Set<string>();
  try {
    for (let i = 0; i < all.length; i += BLACKLIST_PRELOAD_CHUNK) {
      const { data, error } = await db.rpc("blacklisted_phone_keys", {
        p_keys: all.slice(i, i + BLACKLIST_PRELOAD_CHUNK),
      });
      if (error) {
        console.warn("[Cron] Blacklist por tick indisponível; revalidando por envio:", error.message);
        return undefined;
      }
      for (const row of (data ?? []) as Array<{ key: string | null }>) if (row.key) blocked.add(row.key);
    }
  } catch (error) {
    console.warn("[Cron] Blacklist por tick indisponível; revalidando por envio:", error);
    return undefined;
  }
  return (phone) => {
    const key = phoneKey(phone);
    if (!key || !keys.has(key)) return undefined;
    return blocked.has(key);
  };
}
