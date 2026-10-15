"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Espera de eventos antes de reler a contagem: uma rajada de mensagens vira UMA leitura.
const REFETCH_DEBOUNCE_MS = 3_000;

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 *
 * A contagem vem do banco (count exato, só o número): antes cada página do CRM baixava
 * (id, unread_count) de TODAS as conversas visíveis só para somar no navegador.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // RLS scopes this to the signed-in user automatically — no explicit user_id filter needed here.
    const load = async () => {
      const { count, error } = await supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .gt("unread_count", 0);
      if (cancelled || error || count == null) return;
      setTotal(count);
    };

    void load();

    const channel = supabase
      .channel("total-unread-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  return total;
}
