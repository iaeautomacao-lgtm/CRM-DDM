import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  adminFrom: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => {
  class ForbiddenError extends Error {
    readonly status = 403;
  }
  return {
    ForbiddenError,
    getCurrentAccount: mocks.account,
    toErrorResponse: (err: unknown) =>
      new Response(JSON.stringify({ error: String(err) }), {
        status: (err as { status?: number })?.status ?? 500,
      }),
  };
});

function chain(result: unknown): unknown {
  const proxy: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "limit", "gte", "order", "range"]) {
    proxy[m] = () => chain(result);
  }
  proxy.single = async () => result;
  proxy.maybeSingle = async () => result;
  proxy.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return proxy;
}

vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      mocks.adminFrom(table);
      if (table === "whatsapp_config") {
        return chain({
          data: [{ id: "session-1", display_phone_number: "551199999999", phone_number_id: "pn1", waha_session: null, provider: "meta", habilitado: true }],
          error: null,
        });
      }
      if (table === "channel_health") {
        return chain({
          data: [{ session_id: "session-1", verified_name: "Principal", display_phone_number: "551199999999", checked_at: "2026-10-08T10:00:00Z", last_error: null }],
          error: null,
        });
      }
      if (table === "system_logs") {
        return chain({
          data: [
            {
              id: "log-1",
              created_at: "2026-10-06T15:00:00Z",
              payload: {
                status: "finished",
                duration_ms: 30000,
                budget_ms: 35000,
                campaigns: 1,
                stopped_early: false,
                totals: { sent: 480, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0 },
                latency: {
                  meta: { count: 480, avg_ms: 900, p95_ms: 1200, max_ms: 1500 },
                  waha: { count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 },
                },
                event_loop_lag_p99_ms: 25,
                rss_mb: 315,
                rss_peak_mb: 320,
                backoff_events: [],
              },
            },
          ],
          error: null,
        });
      }
      if (table === "dispatch_throughput_per_minute") {
        return chain({
          data: [
            { session_id: "session-1", minute: "2026-10-06T15:00:00Z", sent: 480 },
          ],
          error: null,
        });
      }
      return chain({ data: [], error: null });
    },
  }),
}));

import { GET } from "./route";

describe("GET /api/disparador/desempenho - controle de acesso e resposta", () => {
  afterEach(() => vi.clearAllMocks());

  it("retorna 403 para usuários com papel não autorizado (viewer / agent)", async () => {
    mocks.account.mockResolvedValue({ userId: "u1", accountId: "acc1", role: "viewer" });
    const res = await GET(new Request("https://crm.test/api/disparador/desempenho?janela=1h"));
    expect(res.status).toBe(403);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("retorna 200 com payload estruturado para admin / owner", async () => {
    mocks.account.mockResolvedValue({ userId: "u1", accountId: "acc1", role: "admin" });
    const res = await GET(new Request("https://crm.test/api/disparador/desempenho?janela=15m"));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.janela).toBe("15m");
    expect(json.metrics.nowSent).toBe(480);
    expect(json.metrics.latestMetaP95).toBe(1200);
    expect(json.metrics.hasBrakeTriggered).toBe(false);
    expect(json.ticks).toHaveLength(1);
    expect(json.throughputSeries).toHaveLength(1);
    expect(json.channels).toHaveLength(1);
    expect(json.channels[0].label).toBe("Principal");
  });
});
