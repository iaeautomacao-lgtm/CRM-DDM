"use client";

import { useCallback, useMemo } from "react";
import useSWR, { useSWRConfig, type SWRConfiguration, type SWRResponse } from "swr";
import { useAuth } from "@/hooks/use-auth";
import { swrJsonFetcher } from "./fetcher";
import { buildSwrKey, matchesSwrName, type SwrKey, type SwrParam, type SwrScope } from "./keys";

/** Escopo (conta + usuário) atual; null até o perfil resolver. */
export function useSwrScope(): SwrScope | null {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  return useMemo(() => (userId && accountId ? { userId, accountId } : null), [userId, accountId]);
}

type ScopedOptions<T> = Omit<SWRConfiguration<T, Error>, "fetcher"> & {
  /** false desliga a busca (chave nula). Padrão: true. */
  enabled?: boolean;
};

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
  const { enabled = true, ...swrOptions } = options;
  const paramsKey = JSON.stringify(params);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey é a identidade estável de params
  const key = useMemo(() => (enabled ? buildSwrKey(scope, name, params) : null), [enabled, scope, name, paramsKey]);
  return useSWR<T, Error, SwrKey | null>(key, () => loader(), swrOptions);
}

/** GET JSON de uma rota /api/*, com chave escopada. O caminho não pode conter dado pessoal. */
export function useApiSWR<T>(path: string | null, options: ScopedOptions<T> = {}): SWRResponse<T, Error> {
  const scope = useSwrScope();
  const { enabled = true, ...swrOptions } = options;
  const key = useMemo(() => (enabled && path ? buildSwrKey(scope, "GET", [path]) : null), [enabled, path, scope]);
  return useSWR<T, Error, SwrKey | null>(
    key,
    (k) => swrJsonFetcher<T>(String(k[4])),
    swrOptions,
  );
}

/** Invalida (e revalida) todas as entradas de um nome, de qualquer parâmetro — chamar após escrever. */
export function useSwrInvalidate(): (name: string) => Promise<unknown> {
  const { mutate } = useSWRConfig();
  return useCallback((name: string) => mutate((key: unknown) => matchesSwrName(key, name)), [mutate]);
}
