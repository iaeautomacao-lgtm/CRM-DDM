export interface LivePerformanceSnapshot {
  sampledAt: string;
  activeCampaigns: number;
  queued: number;
  sending: number;
  errors: number;
  blocked: number;
  remaining: number;
  sentLast60s: number;
  /** Campos cuja contagem bateu no teto de custo (migration 198) — o valor mostrado é um mínimo. Ausente = tudo exato. */
  capped?: Partial<Record<"queued" | "sending" | "errors" | "blocked" | "sentLast60s", boolean>>;
}

export function buildLivePerformanceSnapshot(params: {
  sampledAt: string;
  activeCampaigns: number;
  queued?: number | null;
  sending?: number | null;
  errors?: number | null;
  blocked?: number | null;
  sentLast60s?: number | null;
  capped?: LivePerformanceSnapshot["capped"];
}): LivePerformanceSnapshot {
  const queued = Math.max(0, params.queued ?? 0);
  const sending = Math.max(0, params.sending ?? 0);
  const errors = Math.max(0, params.errors ?? 0);
  const blocked = Math.max(0, params.blocked ?? 0);
  const sentLast60s = Math.max(0, params.sentLast60s ?? 0);

  return {
    sampledAt: params.sampledAt,
    activeCampaigns: Math.max(0, params.activeCampaigns),
    queued,
    sending,
    errors,
    blocked,
    remaining: queued + sending,
    sentLast60s,
    ...(params.capped && Object.values(params.capped).some(Boolean) ? { capped: params.capped } : {}),
  };
}

type LiveRpcDb = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> };

/**
 * Contagens do polling de Desempenho numa ida ao banco só (migration 198, dispatch_live_counts). `null` = função
 * ausente ou falha: o chamador usa as contagens de antes.
 */
export async function loadLiveCountsViaRpc(
  db: LiveRpcDb,
  accountId: string,
): Promise<{ counts: { activeCampaigns: number; queued: number; sending: number; errors: number; blocked: number; sentLast60s: number }; capped: NonNullable<LivePerformanceSnapshot["capped"]> } | null> {
  if (typeof db.rpc !== "function") return null;
  let result: Awaited<ReturnType<LiveRpcDb["rpc"]>>;
  try {
    result = await db.rpc("dispatch_live_counts", { p_account_id: accountId });
  } catch {
    return null;
  }
  const { data, error } = result;
  if (error || !data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
  const c = (r.capped ?? {}) as Record<string, unknown>;
  return {
    counts: {
      activeCampaigns: n(r.active_campaigns),
      queued: n(r.queued),
      sending: n(r.sending),
      errors: n(r.errors),
      blocked: n(r.blocked),
      sentLast60s: n(r.sent_last_60s),
    },
    capped: { queued: !!c.queued, sending: !!c.sending, errors: !!c.errors, blocked: !!c.blocked, sentLast60s: !!c.sent_last_60s },
  };
}
