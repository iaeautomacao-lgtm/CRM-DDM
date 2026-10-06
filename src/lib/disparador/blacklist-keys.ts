import type { SupabaseClient } from "@supabase/supabase-js";
import { phoneKey } from "./phone-key";

// Chaves (phoneKey) de toda a blacklist, paginado via .range() — sem
// paginação o PostgREST corta em 1000 linhas e números fora do corte
// deixavam de ser excluídos, sem erro nenhum. Mesmo padrão de
// startCampaign.ts, com ORDER BY id para as páginas serem estáveis. A
// blacklist não tem account_id (lista única da instância). Erro de leitura
// lança: seguir sem a blacklist enviaria para números bloqueados.
export async function loadBlacklistKeySet(db: SupabaseClient): Promise<Set<string>> {
  const keys = new Set<string>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data: page, error } = await db
      .from("blacklist")
      .select("telefone")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Erro ao carregar blacklist: ${error.message}`);
    for (const row of page ?? []) {
      if (row.telefone) keys.add(phoneKey(row.telefone));
    }
    if (!page || page.length < pageSize) break;
    from += pageSize;
  }
  return keys;
}
