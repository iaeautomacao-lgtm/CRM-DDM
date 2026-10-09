// PRD 17.6 — período do relatório, taxa de adiadas e alertas da régua.
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/v1/respond";

import { billingAlerts, brasiliaDay, deferredRate, parseReportRange, rulerReport, type RulerReport } from "./reports";

const A = "00000000-0000-0000-0000-00000000000a";
const R = "10000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-10-19T15:00:00Z");

describe("parseReportRange", () => {
  it("padrão = últimos 30 dias até hoje (Brasília)", () => {
    expect(brasiliaDay(new Date("2026-10-19T01:00:00Z"))).toBe("2026-10-18"); // 22:00 do dia 18 em Brasília
    expect(parseReportRange(null, null, NOW)).toEqual({ from: "2026-09-20", to: "2026-10-19" });
    expect(parseReportRange("2026-10-01", null, NOW)).toEqual({ from: "2026-10-01", to: "2026-10-19" });
  });

  it("recusa data inválida, período invertido e mais de 93 dias", () => {
    expect(() => parseReportRange("2026-02-30", null, NOW)).toThrow(ApiError);
    expect(() => parseReportRange("2026-10-10", "2026-10-01", NOW)).toThrow(/depois de from/);
    expect(() => parseReportRange("2026-06-01", "2026-10-19", NOW)).toThrow(/93 dias/);
    expect(parseReportRange("2026-07-19", "2026-10-19", NOW).from).toBe("2026-07-19"); // exatamente 93 dias
  });
});

describe("deferredRate", () => {
  const tick = (checked: number, deferred: number) => ({ payload: { precheck: { checked, deferred } } });
  it("soma os ticks; amostra pequena não alerta", () => {
    expect(deferredRate([tick(30, 10), tick(30, 10)])).toEqual({ rate: 20 / 80, sample: 80 });
    expect(deferredRate([tick(5, 5)])).toBeNull();
    expect(deferredRate([{ payload: null }, {}])).toBeNull();
  });
});

type RpcResult = { data?: unknown; error?: { code?: string; message: string } | null };
const fakeDb = (opts: { stats?: unknown; statsError?: RpcResult["error"]; logs?: unknown[]; channels?: unknown[]; rulerFound?: boolean; report?: RpcResult }) =>
  ({
    rpc: vi.fn(async (name: string) => (name === "billing_alert_stats" ? { data: opts.stats ?? {}, error: opts.statsError ?? null } : { data: null, error: null, ...(opts.report ?? {}) })),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "in", "limit"]) b[m] = () => b;
      b.then = (resolve: (v: unknown) => void) => {
        if (table === "system_logs") return resolve({ data: opts.logs ?? [], error: null });
        if (table === "whatsapp_config") return resolve({ data: opts.channels ?? [], error: null });
        if (table === "billing_rulers") return resolve({ data: opts.rulerFound === false ? [] : [{ id: R }], error: null });
        resolve({ data: [], error: null });
      };
      return b;
    },
  }) as never;

const stats = (over: Record<string, unknown> = {}) => ({
  reserved_stuck: 0, oldest_reserved_s: null, sync: [{ source: "ddm", last_success_at: "2026-10-19T14:30:00Z", last_run_at: null, last_error: null }],
  live_rulers: [{ id: R, name: "Padrão", channel_id: "CH1" }], open_debts: 10, ...over,
});
const codes = async (db: unknown, deps = {}) => (await billingAlerts(db as never, A, { now: () => NOW, redChannels: async () => [], ...deps })).alerts.map((a) => a.code);

describe("billingAlerts", () => {
  const ch = [{ id: "CH1", habilitado: true }];

  it("tudo certo ⇒ nenhum alerta", async () => {
    expect(await codes(fakeDb({ stats: stats(), channels: ch }))).toEqual([]);
  });

  it("sincronização: > 1 h sem sucesso = crítico; nunca teve sucesso = crítico; régua só em dry-run não alerta", async () => {
    const stale = stats({ sync: [{ source: "ddm", last_success_at: "2026-10-19T13:50:00Z", last_run_at: null, last_error: "timeout" }] });
    expect(await codes(fakeDb({ stats: stale, channels: ch }))).toEqual(["sync_stale"]);
    const never = stats({ sync: [{ source: "ddm", last_success_at: null, last_run_at: null, last_error: null }] });
    expect(await codes(fakeDb({ stats: never, channels: ch }))).toEqual(["sync_never_succeeded"]);
    expect(await codes(fakeDb({ stats: { ...never, live_rulers: [] }, channels: ch }))).toEqual([]);
  });

  it("etapas reservadas há > 15 min", async () => {
    const out = await billingAlerts(fakeDb({ stats: stats({ reserved_stuck: 3, oldest_reserved_s: 1500 }), channels: ch }), A, { now: () => NOW, redChannels: async () => [] });
    expect(out.alerts).toEqual([expect.objectContaining({ code: "reserved_stuck", severity: "warning", detail: { count: 3, oldest_s: 1500 } })]);
  });

  it("taxa de adiadas por falha da DDM > 20% na última hora", async () => {
    const logs = [{ payload: { precheck: { checked: 60, deferred: 40 } } }];
    expect(await codes(fakeDb({ stats: stats(), channels: ch, logs }))).toEqual(["deferred_rate_high"]);
    expect(await codes(fakeDb({ stats: stats(), channels: ch, logs: [{ payload: { precheck: { checked: 90, deferred: 10 } } }] }))).toEqual([]);
  });

  it("régua ligada sem canal, com canal desabilitado ou em qualidade vermelha", async () => {
    expect(await codes(fakeDb({ stats: stats({ live_rulers: [{ id: R, name: "X", channel_id: null }] }) }))).toEqual(["ruler_without_channel"]);
    expect(await codes(fakeDb({ stats: stats(), channels: [{ id: "CH1", habilitado: false }] }))).toEqual(["ruler_channel_disabled"]);
    expect(await codes(fakeDb({ stats: stats(), channels: ch }), { redChannels: async () => [{ id: "CH1" }] })).toEqual(["ruler_channel_red"]);
  });

  it("migration ausente ⇒ 503 (nunca erro cru do banco)", async () => {
    await expect(billingAlerts(fakeDb({ statsError: { code: "42883", message: "x" } }), A)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });
});

describe("rulerReport", () => {
  it("normaliza números, mantém só contagens e mapeia erros do banco", async () => {
    const raw = {
      steps: [{ step_id: "S1", position: 0, offset_days: -3, active: true, sent: "5", delivered: "4", read: "3", replied: "2", errors: "1", paid_after: "1" }],
      totals: { sent: "5", delivered: "4", read: "3", replied: "2", errors: "1" },
      payments: { paid_after_charge: "1", paid_without_charge: "0", avg_charges_before_payment: "1.50", by_charges: [{ charges: 1, total: "1" }] },
      daily: [{ day: "2026-10-10", sent: "5", paid_after: "1" }],
    };
    const out: RulerReport = await rulerReport(fakeDb({ report: { data: raw } }), A, R, { from: "2026-10-01", to: "2026-10-31" });
    expect(out.steps[0]).toMatchObject({ sent: 5, replied: 2, paid_after: 1 });
    expect(out.payments).toEqual({ paid_after_charge: 1, paid_without_charge: 0, avg_charges_before_payment: 1.5, by_charges: [{ charges: 1, total: 1 }] });
    expect(JSON.stringify(out)).not.toMatch(/phone|cpf|telefone/i);
    await expect(rulerReport(fakeDb({ report: { error: { message: "range_invalid" } } }), A, R, { from: "x", to: "y" })).rejects.toMatchObject({ status: 400 });
    await expect(rulerReport(fakeDb({ report: { error: { code: "42883", message: "x" } } }), A, R, { from: "x", to: "y" })).rejects.toMatchObject({ status: 503 });
    await expect(rulerReport(fakeDb({ rulerFound: false }), A, R, { from: "x", to: "y" })).rejects.toMatchObject({ status: 404 });
  });
});
