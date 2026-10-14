"use client";

import { useCallback, useEffect, useState } from "react";

export type UtmpayLoad<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; code: number };

/**
 * Busca um dado do UTMpay quando `key` muda (id da campanha/conversa/contato, período…). O estado carrega a chave
 * pedida: resposta de outra chave nunca aparece (troca rápida de conversa) e "carregando" é derivado, sem setState
 * síncrono no efeito. `reload` busca de novo.
 */
export function useUtmpayData<T>(key: string | null, fetcher: (key: string) => Promise<T>) {
  const [result, setResult] = useState<{ key: string; value: UtmpayLoad<T> } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    fetcher(key).then(
      (data) => {
        if (!cancelled) setResult({ key: `${key}#${nonce}`, value: { status: "ready", data } });
      },
      (err: unknown) => {
        if (cancelled) return;
        const e = err as { message?: string; status?: number };
        setResult({ key: `${key}#${nonce}`, value: { status: "error", message: e?.message ?? "Não foi possível carregar.", code: e?.status ?? 0 } });
      },
    );
    return () => {
      cancelled = true;
    };
    // fetcher é estável por chamada do consumidor (função de módulo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const state: UtmpayLoad<T> | null = key === null ? null : result && result.key === `${key}#${nonce}` ? result.value : { status: "loading" };
  return { state, reload };
}
