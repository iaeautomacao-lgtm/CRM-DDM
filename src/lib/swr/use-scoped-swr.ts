"use client";

import { useCallback, useEffect, useMemo } from "react";
import useSWR, { unstable_serialize, useSWRConfig, type SWRConfiguration, type SWRResponse } from "swr";
import { useAuth } from "@/hooks/use-auth";
import { getSwrCacheStore } from "./cache";
import { swrJsonFetcher } from "./fetcher";
import { buildSwrKey, matchesSwrName, type SwrKey, type SwrParam, type SwrScope } from "./keys";
import { DEFAULT_MAX_ENTRIES, isRetained, touchRetained, type Retention } from "./retention";

/** Escopo (conta + usuário) atual; null até o perfil resolver. */
export function useSwrScope(): SwrScope | null {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  return useMemo(() => (userId && accountId ? { userId, accountId } : null), [userId, accountId]);
}

type ScopedOptions<T> = Omit<SWRConfiguration<T, Error>, "fetcher"> & {
  /** false desliga a busca (chave nula). Padrão: true. */
  enabled?: boolean;
  /** Teto de memória das chaves deste nome (ver retention.ts). Padrão: 30 entradas por nome. */
  retain?: Retention;
};

/**
 * Mantém o cache deste nome dentro do teto: a chave em uso vira a mais recente e o excedente (páginas/buscas antigas) é
 * apagado. Devolve o `fetcher` embrulhado: uma resposta que chega depois de a chave ter saído do teto não fica no cache.
 */
function useRetention<T>(name: string, key: SwrKey | null, retention: Retention | undefined, load: () => Promise<T>): () => Promise<T> {
  const cacheKey = key ? unstable_serialize(key) : null;
  const maxEntries = retention?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const group = retention?.group;
  const maxGroups = retention?.maxGroups;

  useEffect(() => {
    if (cacheKey) touchRetained(getSwrCacheStore(), name, cacheKey, { maxEntries, group, maxGroups });
  }, [name, cacheKey, maxEntries, group, maxGroups]);

  return useCallback(async () => {
    if (cacheKey) touchRetained(getSwrCacheStore(), name, cacheKey, { maxEntries, group, maxGroups });
    try {
      return await load();
    } finally {
      if (cacheKey) {
        // O SWR grava a resposta logo depois; se a chave já saiu do teto nesse meio tempo, apaga em seguida.
        setTimeout(() => {
          if (!isRetained(name, cacheKey)) getSwrCacheStore().delete(cacheKey);
        }, 0);
      }
    }
  }, [name, cacheKey, maxEntries, group, maxGroups, load]);
}

/**
 * Cache com chave [conta, usuário, nome, ...params] para qualquer carregador
 * (Supabase, RPC, rota). `params` só aceita ids/enums — nunca termo de busca
 * ou dado pessoal (ver keys.ts).
 */
export function useScopedSWR<T>(
  name: string,
  params: readonly SwrParam[],
  loader: () => Promise<T>,
  options: ScopedOptions<T> = {},
): SWRResponse<T, Error> {
  const scope = useSwrScope();
  const { enabled = true, retain, ...swrOptions } = options;
  const paramsKey = JSON.stringify(params);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey é a identidade estável de params
  const key = useMemo(() => (enabled ? buildSwrKey(scope, name, params) : null), [enabled, scope, name, paramsKey]);
  const fetcher = useRetention(name, key, retain, loader);
  return useSWR<T, Error, SwrKey | null>(key, fetcher, swrOptions);
}

/** GET JSON de uma rota /api/*, com chave escopada. O caminho não pode conter dado pessoal. */
export function useApiSWR<T>(path: string | null, options: ScopedOptions<T> = {}): SWRResponse<T, Error> {
  const scope = useSwrScope();
  const { enabled = true, retain, ...swrOptions } = options;
  const key = useMemo(() => (enabled && path ? buildSwrKey(scope, "GET", [path]) : null), [enabled, path, scope]);
  // O teto vale por rota (sem a query): meses/filtros da mesma rota não se acumulam.
  const name = `GET:${(path ?? "").split("?")[0]}`;
  const load = useCallback(() => swrJsonFetcher<T>(String(path)), [path]);
  const fetcher = useRetention(name, key, retain, load);
  return useSWR<T, Error, SwrKey | null>(key, fetcher, swrOptions);
}

/** Invalida (e revalida) todas as entradas de um nome, de qualquer parâmetro — chamar após escrever. */
export function useSwrInvalidate(): (name: string) => Promise<unknown> {
  const { mutate } = useSWRConfig();
  return useCallback((name: string) => mutate((key: unknown) => matchesSwrName(key, name)), [mutate]);
}
