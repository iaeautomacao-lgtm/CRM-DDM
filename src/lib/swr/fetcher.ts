"use client";

import { apiFetch, isMfaRequiredResponse } from "@/lib/api-fetch";
import { createClient } from "@/lib/supabase/client";
import { clearSwrCache } from "./cache";

export class SwrHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "SwrHttpError";
    this.status = status;
  }
}

/**
 * 401 que sobrou depois do retry do apiFetch: a sessão pode ter expirado.
 * Sempre esvazia o cache (nada de dado de uma sessão morta na memória). Só
 * encerra e vai ao login se o navegador também já não tem sessão — um 401
 * isolado com sessão viva não derruba o usuário.
 */
async function defaultOnUnauthorized(): Promise<void> {
  clearSwrCache();
  if (typeof window === "undefined") return;
  const supabase = createClient();
  const { data } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  if (data.session) return;
  await supabase.auth.signOut().catch(() => undefined);
  window.location.replace("/login");
}

let onUnauthorized: () => Promise<void> = defaultOnUnauthorized;

/** Só para testes. */
export function setSwrUnauthorizedHandler(handler: (() => Promise<void>) | null): void {
  onUnauthorized = handler ?? defaultOnUnauthorized;
}

/**
 * GET JSON com cookies da mesma origem (apiFetch já usa same-origin e trata
 * 2FA, membro desativado e o retry de 401). `cache: "no-store"` mantém o
 * cache HTTP do navegador fora: quem guarda é o SWR, em memória.
 */
export async function swrJsonFetcher<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: "GET", credentials: "same-origin", cache: "no-store" });
  if (res.status === 401) {
    if (!(await isMfaRequiredResponse(res))) await onUnauthorized();
    throw new SwrHttpError(401);
  }
  if (!res.ok) throw new SwrHttpError(res.status);
  return (await res.json()) as T;
}
