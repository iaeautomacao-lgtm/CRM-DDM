"use client";

/**
 * "Debug no editor" — n8n-style "see which path a specific run took"
 * mode for the Flow Builder canvas. Reads `?run_id=` off the URL,
 * loads that run's `flow_run_events` timeline (same endpoint the
 * run-history viewer uses: `GET /api/flows/[id]/runs?run_id=`), and
 * exposes per-node classification + the run's own metadata so the
 * canvas can render an overlay without knowing anything about the
 * fetch/URL plumbing itself.
 *
 * `run_id` absent → `isDebugMode` is false and every other field is
 * empty/no-op — callers don't need a separate "not in debug mode"
 * branch, they can just always read `nodeStatus()` etc.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface FlowDebugEvent {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  node_type: string | null;
  status: "success" | "error" | "skipped" | null;
  error_message: string | null;
  duration_ms: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface FlowDebugRunMeta {
  id: string;
  status: string;
  started_at: string;
  contact: { id: string; name: string | null; phone: string } | null;
}

export type NodeDebugStatus = "success" | "error" | "stalled" | "unreached";

export interface FlowDebugState {
  isDebugMode: boolean;
  runId: string | null;
  loading: boolean;
  runMeta: FlowDebugRunMeta | null;
  /** null outside debug mode — nothing to classify against. */
  nodeStatus: (nodeKey: string) => NodeDebugStatus | null;
  eventsForNode: (nodeKey: string) => FlowDebugEvent[];
  exitDebugMode: () => void;
}

export function useFlowDebug(flowId: string | undefined): FlowDebugState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const runId = searchParams.get("run_id");

  const [events, setEvents] = useState<FlowDebugEvent[]>([]);
  const [runMeta, setRunMeta] = useState<FlowDebugRunMeta | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!flowId || !runId) {
      setEvents([]);
      setRunMeta(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // Reusing the run-history viewer's own endpoint rather than a
        // separate /runs/[runId]/events route — it already does the
        // exact query (events for one run_id, ownership-scoped via
        // RLS) and already returns the run's own row (contact,
        // started_at) in its `runs` array, so no second request is
        // needed for the debug banner's metadata either.
        const res = await fetch(`/api/flows/${flowId}/runs?run_id=${runId}`);
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as {
          runs: FlowDebugRunMeta[];
          events: FlowDebugEvent[];
        };
        if (cancelled) return;
        setEvents(json.events ?? []);
        setRunMeta((json.runs ?? []).find((r) => r.id === runId) ?? null);
      } catch (err) {
        if (!cancelled) {
          console.error("[use-flow-debug] fetch failed:", err);
          setEvents([]);
          setRunMeta(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId, runId]);

  // Classification buckets, per the spec's priority: a node that ever
  // errored reads as an error even if some other visit (e.g. an
  // ai_agent loop revisiting the same node_key across turns) also
  // completed successfully — surfacing the problem beats hiding it
  // behind a later success.
  const { successKeys, errorKeys, enteredKeys } = useMemo(() => {
    const successKeys = new Set<string>();
    const errorKeys = new Set<string>();
    const enteredKeys = new Set<string>();
    for (const e of events) {
      if (!e.node_key) continue;
      if (e.event_type === "node_completed") successKeys.add(e.node_key);
      else if (e.event_type === "node_error") errorKeys.add(e.node_key);
      else if (e.event_type === "node_entered") enteredKeys.add(e.node_key);
    }
    return { successKeys, errorKeys, enteredKeys };
  }, [events]);

  const isDebugMode = Boolean(runId);

  const nodeStatus = useCallback(
    (nodeKey: string): NodeDebugStatus | null => {
      if (!isDebugMode) return null;
      if (errorKeys.has(nodeKey)) return "error";
      if (successKeys.has(nodeKey)) return "success";
      if (enteredKeys.has(nodeKey)) return "stalled";
      return "unreached";
    },
    [isDebugMode, errorKeys, successKeys, enteredKeys],
  );

  const eventsForNode = useCallback(
    (nodeKey: string) => events.filter((e) => e.node_key === nodeKey),
    [events],
  );

  const exitDebugMode = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("run_id");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [router, pathname, searchParams]);

  // Memoized so consumers that key their own useMemo/useEffect off this
  // returned object (e.g. FlowCanvas's derivedRfNodes) don't recompute
  // on every unrelated render — only when something here actually
  // changed. nodeStatus/eventsForNode/exitDebugMode are already stable
  // via useCallback with correct deps.
  return useMemo(
    () => ({
      isDebugMode,
      runId,
      loading,
      runMeta,
      nodeStatus,
      eventsForNode,
      exitDebugMode,
    }),
    [isDebugMode, runId, loading, runMeta, nodeStatus, eventsForNode, exitDebugMode],
  );
}
