import type { SupabaseClient } from "@supabase/supabase-js";
import { phoneKey } from "./phone-key";
import { fetchAllKeyset } from "./keyset";

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
