"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import type { QuickReply } from "@/lib/quick-replies";

// Lista da conta em cache no módulo: o composer remonta a cada conversa
// aberta e não deve buscar de novo toda vez. A tela de cadastro chama
// invalidateQuickReplies() depois de salvar.
let cache: { accountId: string; list: QuickReply[]; at: number } | null = null;
const TTL_MS = 5 * 60_000;
const listeners = new Set<() => void>();

export function invalidateQuickReplies(): void {
  cache = null;
  for (const l of listeners) l();
}

export function useQuickReplies(): { replies: QuickReply[]; loading: boolean; reload: () => void } {
  const { accountId } = useAuth();
  // Começa com o cache (mesmo vencido) para não piscar; o efeito abaixo
  // revalida quando passou do TTL.
  const cached = cache && cache.accountId === accountId ? cache.list : null;
  const [replies, setReplies] = useState<QuickReply[]>(cached ?? []);
  const [loading, setLoading] = useState(cached === null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const hit =
      cache && cache.accountId === accountId && Date.now() - cache.at < TTL_MS ? cache.list : null;
    const load: PromiseLike<{ list: QuickReply[]; ok: boolean }> = hit
      ? Promise.resolve({ list: hit, ok: true })
      : createClient()
          .from("quick_replies")
          .select("*")
          .eq("account_id", accountId)
          .order("shortcut", { ascending: true })
          .range(0, 499)
          .then(({ data, error }) => {
            // Tabela ainda não criada (142 não aplicada) ou falha de rede:
            // o composer só fica sem sugestões.
            if (error) console.error("[quick-replies] falha ao carregar:", error.message);
            const list = (data ?? []) as QuickReply[];
            if (!error) cache = { accountId, list, at: Date.now() };
            return { list, ok: !error };
          });
    void Promise.resolve(load).then(({ list }) => {
      if (cancelled) return;
      setReplies(list);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, version]);

  const reload = useCallback(() => invalidateQuickReplies(), []);
  return { replies, loading, reload };
}

/**
 * Registra que o operador USOU a resposta (alimenta "Usos (30 d)" na tela de cadastro). Telemetria: não bloqueia o envio
 * nem avisa erro — falhou, só não conta.
 */
export function trackQuickReplyUse(id: string): void {
  void apiFetch(`/api/quick-replies/${id}/use`, { method: "POST" }).catch(() => {});
}
