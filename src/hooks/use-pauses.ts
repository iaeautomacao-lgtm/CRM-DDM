"use client";

// Ganchos das pausas de atendimento. O Realtime (agent_pauses) só serve de
// aviso: ao chegar um evento, a leitura é refeita pela rota (a fonte de
// verdade); uma releitura a cada 60 s cobre eventos perdidos.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permission";
import { pausasApi, type PauseApiError } from "@/lib/pausas/client";
import type { Pause, PauseReason, TeamPause } from "@/lib/pausas/pause";

const REFRESH_MS = 60_000;

/** Atalho para as permissões das pausas (o servidor decide de novo em cada rota). */
export function usePausePermissions() {
  const { can } = usePermissions();
  return {
    canPauseSelf: can("presence.pause_self"),
    canPauseOthers: can("presence.pause_others"),
    canManageReasons: can("presence.reasons_manage"),
  };
}

/** Chama `onChange` ao ligar, a cada evento de agent_pauses visível para o usuário e a cada 60 s. */
function useAgentPausesSignal(enabled: boolean, onChange: () => void, channelName: string) {
  const ref = useRef(onChange);
  useEffect(() => {
    ref.current = onChange;
  });
  useEffect(() => {
    if (!enabled) return;
    queueMicrotask(() => ref.current());
    const supabase = createClient();
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "wacrm", table: "agent_pauses" }, () => ref.current())
      .subscribe();
    const poll = window.setInterval(() => {
      if (!document.hidden) ref.current();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) ref.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, channelName]);
}

/** Relógio em ms que anda a cada `everyMs` (cronômetro sem nova consulta). */
export function useNowMs(everyMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs, enabled]);
  return now;
}

/** A pausa do usuário logado, os motivos disponíveis e as ações de pausar/voltar. */
export function useMyPause() {
  const { canPauseSelf } = usePausePermissions();
  const { user } = useAuth();
  const [pause, setPause] = useState<Pause | null>(null);
  const [reasons, setReasons] = useState<PauseReason[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await pausasApi.myPause();
    if (res.ok) {
      setPause(res.data.pause);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!canPauseSelf) return;
    void pausasApi.reasons().then((r) => {
      if (r.ok) setReasons(r.data.reasons);
    });
  }, [canPauseSelf]);

  useAgentPausesSignal(canPauseSelf && !!user?.id, reload, "my-pause");

  const start = useCallback(async (reasonId: string): Promise<PauseApiError | null> => {
    setBusy(true);
    try {
      const res = await pausasApi.start(reasonId);
      if (res.ok) {
        setPause(res.data.pause);
        return null;
      }
      if (res.error.code === "already_paused" && res.error.pause) setPause(res.error.pause);
      return res.error;
    } finally {
      setBusy(false);
    }
  }, []);

  const resume = useCallback(async (): Promise<PauseApiError | null> => {
    setBusy(true);
    try {
      const res = await pausasApi.resume();
      if (res.ok) {
        setPause(null);
        return null;
      }
      if (res.error.code === "not_paused") setPause(null);
      return res.error;
    } finally {
      setBusy(false);
    }
  }, []);

  return { enabled: canPauseSelf, loaded, pause, reasons, busy, start, resume, reload };
}

/** Pausas abertas do escopo do supervisor (Monitoramento), por atendente. */
export function useTeamPauses(enabled = true) {
  const { can } = usePermissions();
  const allowed = enabled && can("monitoring.view_team");
  const [pauses, setPauses] = useState<TeamPause[]>([]);

  const reload = useCallback(async () => {
    const res = await pausasApi.team();
    if (res.ok) setPauses(res.data.pauses);
  }, []);

  useAgentPausesSignal(allowed, reload, "team-pauses");

  const byUser = useMemo(() => new Map(pauses.map((p) => [p.user_id, p])), [pauses]);
  return { pauses, byUser, reload };
}

/** Quem está em pausa agora (só ids), para marcar "em pausa" nas listas de atribuição. */
export function usePausedUserIds(enabled: boolean): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void pausasApi.pausedIds().then((r) => {
      if (!cancelled && r.ok) setIds(new Set(r.data.user_ids));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return ids;
}
