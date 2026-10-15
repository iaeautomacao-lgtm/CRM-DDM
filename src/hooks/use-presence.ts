"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  derivePresence,
  HEARTBEAT_MS,
  type PresenceRow,
  type PresenceStatus,
  type StoredPresence,
} from "@/lib/presence";

// How often the viewer re-derives presence locally. The online→offline
// transition fires NO database event (it's just the clock passing the
// staleness threshold), so without this tick a member who closes their
// tab would appear online forever. ~15s keeps "offline" responsive
// without busy-spinning.
const RE_DERIVE_MS = 15_000;

type PresenceMap = Map<string, PresenceRow>;

interface UsePresenceResult {
  /** Derived status for one member (defaults to offline if unseen). */
  getPresence: (userId: string) => PresenceStatus;
  /** Raw row for tooltips ("last seen …"). */
  getRow: (userId: string) => PresenceRow | undefined;
  /**
   * The clock value the hook is currently deriving against. Pass this
   * to `presenceLabel` / `formatLastSeen` so labels stay in lockstep
   * with the dots (both advance on the same ~15s re-derive tick).
   */
  now: number;
}

/**
 * Live presence for every member of the caller's account. Reads the
 * `member_presence` table (RLS-scoped to the account), re-reads it every
 * HEARTBEAT_MS while the tab is visible, and re-derives "offline" on a local timer.
 *
 * Account comes from useAuth; pass `enabled: false` to opt a consumer
 * out (e.g. while a parent sheet is closed).
 */
export function usePresence(enabled = true): UsePresenceResult {
  const { accountId } = useAuth();

  // Presence rows keyed by user_id, held in immutable state — each
  // update replaces the Map so React renders and the derived getters
  // recompute. No ref/version dance needed.
  const [rows, setRows] = useState<PresenceMap>(() => new Map());

  // `now` ticks so derivePresence re-evaluates staleness over time.
  const [now, setNow] = useState(() => Date.now());

  const active = enabled && !!accountId;

  useEffect(() => {
    if (!active || !accountId) return;

    const supabase = createClient();
    let cancelled = false;

    // Releitura periódica em vez de canal Realtime: o batimento de cada aba (a cada 30 s) escrevia em member_presence e,
    // com a tabela na publication, cada escrita era avaliada pelo Realtime para todos os assinantes da conta (custo
    // cresce com batimentos × assinantes). A tela só precisa do estado a cada batimento: uma leitura barata a cada 30 s.
    const load = () => {
      supabase
        .from("member_presence")
        .select("user_id, status, last_seen_at")
        .eq("account_id", accountId)
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error) {
            console.error("[usePresence] fetch error:", error.message);
            return;
          }
          // Substitui o mapa: quem sumiu da tabela (DELETE) some daqui também.
          const next: PresenceMap = new Map();
          for (const r of data ?? []) {
            next.set(r.user_id as string, {
              status: r.status as StoredPresence,
              last_seen_at: r.last_seen_at as string,
            });
          }
          setRows(next);
        });
    };

    load();
    const poll = setInterval(() => {
      if (!document.hidden) load();
    }, HEARTBEAT_MS);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);

    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, accountId]);

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rows.get(userId),
    [rows],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rows.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rows, now],
  );

  return { getPresence, getRow, now };
}
