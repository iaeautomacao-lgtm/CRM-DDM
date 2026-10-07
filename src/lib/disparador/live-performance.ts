export interface LivePerformanceSnapshot {
  sampledAt: string;
  activeCampaigns: number;
  queued: number;
  sending: number;
  errors: number;
  blocked: number;
  remaining: number;
  sentLast60s: number;
}

export function buildLivePerformanceSnapshot(params: {
  sampledAt: string;
  activeCampaigns: number;
  queued?: number | null;
  sending?: number | null;
  errors?: number | null;
  blocked?: number | null;
  sentLast60s?: number | null;
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
  };
}
