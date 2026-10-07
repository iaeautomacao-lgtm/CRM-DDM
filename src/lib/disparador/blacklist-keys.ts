import type { SupabaseClient } from "@supabase/supabase-js";
import { phoneKey } from "./phone-key";
import { fetchAllKeyset } from "./keyset";
import { processWithConcurrency } from "./concurrency";

// Chaves (phoneKey) de toda a blacklist, paginado por KEYSET (id > cursor) —
// sem paginação o PostgREST corta em 1000 linhas e números fora do corte
// deixavam de ser excluídos, sem erro nenhum; com OFFSET o custo crescia com
// o quadrado do tamanho da lista (B9). A blacklist não tem account_id (lista
// única da instância). Erro de leitura lança: seguir sem a blacklist enviaria
// para números bloqueados.
export async function loadBlacklistKeySet(db: SupabaseClient): Promise<Set<string>> {
  const rows = await fetchAllKeyset<{ id: number | string; telefone: string | null }>(
    "Erro ao carregar blacklist",
    (after, limit) => {
      let query = db.from("blacklist").select("id, telefone").order("id", { ascending: true }).limit(limit);
      if (after != null) query = query.gt("id", after);
      return query;
    },
  );
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.telefone) keys.add(phoneKey(row.telefone));
  }
  return keys;
}

const BLACKLIST_RPC_CHUNK = 2000;
const BLACKLIST_RPC_CONCURRENCY = 3;

// Fallback (RPC ausente): lista inteira em cache curto no processo — um import em blocos manda
// dezenas de requisições seguidas e recarregá-la a cada uma custaria mais que o resto do bloco.
// 60 s de defasagem não importa: startCampaign confere a blacklist de novo ao iniciar.
const FALLBACK_TTL_MS = 60_000;
let fallbackCache: { keys: Set<string>; at: number } | null = null;
/** Só para testes. */
export function resetBlacklistFallbackCache(): void {
  fallbackCache = null;
}

/**
 * Das `keys` (phoneKey) informadas, quais estão na blacklist. Consulta só as chaves do bloco
 * (wacrm.blacklisted_phone_keys, migration 167 — índice de expressão da 168), em fatias e em paralelo,
 * em vez de carregar a lista inteira a cada bloco. Se a RPC não existir/falhar, cai na lista inteira
 * (que lança em erro de leitura: seguir sem a blacklist enviaria para números bloqueados).
 */
export async function loadBlacklistKeysForPhones(db: SupabaseClient, keys: Iterable<string>): Promise<Set<string>> {
  const wanted = [...new Set([...keys].filter(Boolean))];
  const blocked = new Set<string>();
  if (wanted.length === 0) return blocked;
  try {
    const slices: string[][] = [];
    for (let i = 0; i < wanted.length; i += BLACKLIST_RPC_CHUNK) slices.push(wanted.slice(i, i + BLACKLIST_RPC_CHUNK));
    await processWithConcurrency(slices, BLACKLIST_RPC_CONCURRENCY, async (slice) => {
      const { data, error } = await db.rpc("blacklisted_phone_keys", { p_keys: slice });
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Array<{ key: string | null }>) if (row.key) blocked.add(row.key);
    });
    return blocked;
  } catch (err) {
    console.warn("[Blacklist] Consulta por chaves indisponível; usando a lista inteira:", err instanceof Error ? err.message : err);
  }
  if (!fallbackCache || Date.now() - fallbackCache.at >= FALLBACK_TTL_MS) {
    fallbackCache = { keys: await loadBlacklistKeySet(db), at: Date.now() };
  }
  const all = fallbackCache.keys;
  return new Set(wanted.filter((k) => all.has(k)));
}
