"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { useAuth } from "@/hooks/use-auth";
import { clearSessionData } from "@/lib/auth/session-cleanup";
import { clearSwrCache, getSwrCacheStore } from "./cache";
import { scopeId, shouldClearOnScopeChange } from "./scope";

/** Configuração única do SWR no CRM: dedupe de 5 s, revalida ao focar no máximo a cada 60 s, sem retry automático. */
const SWR_OPTIONS = {
  provider: () => getSwrCacheStore(),
  dedupingInterval: 5_000,
  revalidateOnFocus: true,
  focusThrottleInterval: 60_000,
  revalidateOnReconnect: true,
  revalidateIfStale: true,
  shouldRetryOnError: false,
} as const;

/**
 * Vai dentro do AuthProvider. Esvazia o cache quando a conta ou o usuário
 * muda, quando a sessão some (logout / expiração) e ao desmontar.
 */
export function SwrProvider({ children }: { children: ReactNode }) {
  const { user, accountId } = useAuth();
  const current = scopeId(user?.id && accountId ? { userId: user.id, accountId } : null);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (shouldClearOnScopeChange(previous.current, current)) clearSessionData();
    previous.current = current;
  }, [current]);

  useEffect(() => clearSwrCache, []);

  return <SWRConfig value={SWR_OPTIONS}>{children}</SWRConfig>;
}
