"use client";

import { useEffect, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

/**
 * Live count of wacrm.internal_messages (migration 109) addressed to
 * the caller with read_at still null — powers the "Conversar com
 * supervisor" badge in the sidebar. Refetches the count on every
 * Realtime event touching rows where the caller is recipient, rather
 * than incrementing/decrementing locally: a new message (+1) and a
 * mark-as-read UPDATE (-1) both hit this same filter, and a straight
 * recount avoids any drift between the two paths.
 */
export function useUnreadInternalMessages(enabled: boolean): number {
  const { user, accountId } = useAuth();
  const userId = user?.id;
  const [count, setCount] = useState(0);

  useEffect(() => {
    // No setState here when disabled — the caller only renders the
    // badge while `enabled` is true, so a stale count sitting unused
    // in state is harmless, and this keeps the effect body free of
    // the synchronous setState react-hooks/set-state-in-effect flags.
    if (!enabled || !userId || !accountId) return;

    const supabase = createClient();
    let cancelled = false;

    const refetch = () => {
      supabase
        .from("internal_messages")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", userId)
        .is("read_at", null)
        .then(({ count: c, error }) => {
          if (cancelled) return;
          if (error) {
            console.error("[useUnreadInternalMessages] count error:", error.message);
            return;
          }
          setCount(c ?? 0);
        });
    };

    refetch();

    const channel: RealtimeChannel = supabase
      .channel(`internal-chat-badge:${accountId}:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "wacrm",
          table: "internal_messages",
          filter: `recipient_id=eq.${userId}`,
        },
        () => refetch(),
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [enabled, accountId, userId]);

  return count;
}
