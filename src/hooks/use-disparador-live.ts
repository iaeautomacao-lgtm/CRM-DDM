"use client";

import { useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { latencyMs, parseLiveDelta, type LiveDelta } from "@/lib/disparador/live-delta";

/**
 * Acompanhamento ao vivo do Disparador (migration 364): assina o canal privado `disp:<conta>` (broadcast, só admin+ da conta pela RLS de
 * realtime.messages) e entrega cada delta na hora. `connected` = canal assinado: a tela então reconcilia por consulta a cada 45 s em vez de
 * perguntar a cada 3 s; se o canal cair, volta ao polling sozinho. Não assina tabela nenhuma (nem a fila).
 */
export function useDisparadorLive(onDelta: (delta: LiveDelta) => void, enabled = true): { connected: boolean; latencyMs: number | null } {
  const { accountId } = useAuth();
  const [connected, setConnected] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const handlerRef = useRef(onDelta);
  useEffect(() => {
    handlerRef.current = onDelta;
  });

  useEffect(() => {
    if (!enabled || !accountId) return;
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    void (async () => {
      try {
        await supabase.realtime.setAuth();
      } catch {
        // sem token explícito o client usa o da sessão
      }
      if (cancelled) return;
      channel = supabase
        .channel(`disp:${accountId}`, { config: { private: true } })
        .on("broadcast", { event: "delta" }, (message) => {
          const delta = parseLiveDelta(message);
          if (!delta) return;
          setLatency(latencyMs(delta));
          handlerRef.current(delta);
        })
        .subscribe((status) => {
          if (!cancelled) setConnected(status === "SUBSCRIBED");
        });
    })();

    return () => {
      cancelled = true;
      setConnected(false);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [accountId, enabled]);

  return { connected, latencyMs: latency };
}
