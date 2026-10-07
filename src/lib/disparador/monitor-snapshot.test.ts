import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMonitorSnapshot,
  clearMonitorCache,
  computeEtaMinutes,
  formatEtaPt,
  getMonitorSnapshot,
  loadMonitorInput,
  pickRatePerMin,
  type DbCounts,
  type MonitorInput,
  type RawTick,
} from "./monitor-snapshot";
import { resolveThroughputConfig } from "./throughput-config";

const NOW = new Date("2026-10-08T15:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const A = "00000000-0000-0000-0000-00000000000a"; // número da conta
const B = "00000000-0000-0000-0000-00000000000b"; // WAHA da conta
const FOREIGN = "00000000-0000-0000-0000-0000000000ff"; // número de OUTRA conta (aparece no cron_tick global)
const C1 = "00000000-0000-0000-0000-0000000000c1";
const C2 = "00000000-0000-0000-0000-0000000000c2";
const FOREIGN_CAMPAIGN = "00000000-0000-0000-0000-0000000000cf";

function tick(minutesAgo: number, channels: Record<string, Partial<{ sent: number; in_cooldown: boolean; peak_in_flight: number }>>, extra: Record<string, unknown> = {}): RawTick {
  return {
    created_at: iso(minutesAgo),
    payload: {
      status: "processed",
      duration_ms: 40_000,
      budget_ms: 45_000,
      campaigns: 1,
      stopped_early: false,
      totals: { sent: 0, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0 },
      latency: { meta: { count: 10, avg_ms: 800, p95_ms: 1000, max_ms: 1200 }, waha: { count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 } },
      channels: Object.fromEntries(
        Object.entries(channels).map(([id, c]) => [
          id,
          { provider: "meta", sent: 0, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0, in_cooldown: false, ...c },
        ]),
      ),
      ...extra,
    } as never,
  };
}

function baseInput(over: Partial<MonitorInput> = {}): MonitorInput {
  const counts: DbCounts = {
    sessions: [{ session_id: A, sent_1m: 2400, sent_5m: 11_000, in_flight: 40, queued: 8_000 }],
    campaigns: [{ campaign_id: C1, sent_1m: 2400, sent_5m: 11_000 }],
    errors: [
      { campaign_id: C1, erro_codigo: 131049, n: 60 },
      { campaign_id: C1, erro_codigo: null, n: 15 },
      { campaign_id: C2, erro_codigo: 131049, n: 25 },
      { campaign_id: FOREIGN_CAMPAIGN, erro_codigo: 131026, n: 777331 }, // nunca deveria vir; defesa em profundidade
    ],
    has_queue_index: true,
    has_error_code: true,
  };
  return {
    now: NOW,
    channels: [
      { id: A, label: "Cobrança 1", provider: "meta", phone: "+5511999990001", enabled: true },
      { id: B, label: "WAHA 1", provider: "waha", phone: null, enabled: true },
    ],
    limits: new Map([[A, { maxInFlight: 40, hourlyLimit: null }]]),
    cooldowns: new Map(),
    campaigns: [
      { id: C1, nome: "Black Friday", status: "em_execucao", session_ids: [A, FOREIGN], pausa_automatica_motivo: null, updated_at: iso(1) },
      { id: C2, nome: "Cobrança Out", status: "pausada", session_ids: [B], pausa_automatica_motivo: "Pausada automaticamente: 34% de erro (código 132001)", updated_at: iso(30) },
    ],
    metrics: new Map([
      [C1, { total: 100_000, enviados: 40_000, entregues: 30_000, lidos: 10_000, erros: 3_000, blacklist: 1_000 }],
      [C2, { total: 30_000, enviados: 12_000, entregues: 0, lidos: 0, erros: 10_000, blacklist: 0 }],
    ]),
    pending131026: new Map([[C1, 7], [FOREIGN_CAMPAIGN, 50]]),
    ticks: [
      tick(0.5, { [A]: { sent: 1800, peak_in_flight: 40 }, [FOREIGN]: { sent: 5000 } }),
      tick(1.5, { [A]: { sent: 1800 }, [FOREIGN]: { sent: 5000 } }),
    ],
    counts,
    logs: [
      { created_at: iso(30), level: "error", event: "campaign_auto_paused", message: "Pausada automaticamente: 34% de erro", payload: { campaign_id: C2 } },
      { created_at: iso(200), level: "info", event: "cron_tick", message: "x", payload: null }, // evento fora da lista: ignorado
    ],
    throughput: resolveThroughputConfig({}),
    degraded: [],
    ...over,
  };
}

describe("ETA e ritmo", () => {
  it("computeEtaMinutes: restante ÷ ritmo; 0 se nada resta; null sem ritmo", () => {
    expect(computeEtaMinutes(10_000, 500)).toBe(20);
    expect(computeEtaMinutes(0, 0)).toBe(0);
    expect(computeEtaMinutes(-5, 100)).toBe(0);
    expect(computeEtaMinutes(1000, 0)).toBeNull();
    expect(computeEtaMinutes(1000, Number.NaN)).toBeNull();
    expect(computeEtaMinutes(Number.NaN, 10)).toBe(0);
  });
  it("pickRatePerMin: média de 5 min quando existe; senão o último minuto", () => {
    expect(pickRatePerMin(2400, 11_000)).toBe(2200);
    expect(pickRatePerMin(300, 0)).toBe(300);
    expect(pickRatePerMin(0, 0)).toBe(0);
  });
  it("formatEtaPt em português", () => {
    expect(formatEtaPt(null)).toBe("sem ritmo");
    expect(formatEtaPt(0)).toBe("concluído");
    expect(formatEtaPt(0.4)).toBe("menos de 1 min");
    expect(formatEtaPt(35)).toBe("35 min");
    expect(formatEtaPt(130)).toBe("2 h 10 min");
    expect(formatEtaPt(120)).toBe("2 h");
    expect(formatEtaPt(27 * 60)).toBe("1 d 3 h");
  });
});

describe("buildMonitorSnapshot", () => {
  it("por número: ritmo, em voo, fila, ETA, teto teórico; só os números da conta", () => {
    const snap = buildMonitorSnapshot(baseInput());
    expect(snap.numbers.map((n) => n.id)).toEqual([A, B]);
    const a = snap.numbers[0];
    expect(a).toMatchObject({ sent1m: 2400, sent5m: 11_000, ratePerMin: 2200, inFlight: 40, inFlightCap: 40, queued: 8_000, queuedCapped: false, status: "ok", limitPerSecond: null });
    expect(a.etaMinutes).toBeCloseTo(8_000 / 2200, 5);
    // 40 vagas ÷ 0,8 s × 45 s = 2.250/min
    expect(a.theoreticalPerMin).toBe(2250);
    expect(a.avgPerMin15).toBeCloseTo(240, 5); // (1800+1800)/15
    // Número sem contagem do banco (ex.: WAHA sem linha): cai nos ticks e sem fila.
    expect(snap.numbers[1]).toMatchObject({ queued: null, etaMinutes: null, inFlightCap: 4 });
  });

  it("fila por número acima de 10.000 aparece como 10.000+ (nunca conta a fila inteira)", () => {
    const input = baseInput();
    input.counts!.sessions[0].queued = 10_001;
    const a = buildMonitorSnapshot(input).numbers[0];
    expect(a.queued).toBe(10_000);
    expect(a.queuedCapped).toBe(true);
  });

  it("cooldown (banco ou tick) corta as vagas pela metade e vira alerta; freio recente do scheduler aparece", () => {
    const input = baseInput({
      cooldowns: new Map([[A, { until: iso(-3), reason: "rate_limit" }]]),
      ticks: [
        tick(0.5, { [A]: { sent: 100, in_cooldown: true } }, {
          backoff_events: [{ scope: "channel", reason: "rate_limit", session_id: A, from: 40, to: 20 }],
        }),
      ],
    });
    const snap = buildMonitorSnapshot(input);
    expect(snap.numbers[0]).toMatchObject({ status: "cooldown", inFlightCap: 20 });
    expect(snap.numbers[0].brake).toMatch(/de 40 para 20.*limite de taxa da Meta/);
    expect(snap.alerts.some((a) => a.id === `cooldown-${A}` && a.level === "warning")).toBe(true);
    expect(snap.events.some((e) => e.type === "freio" && /Cobrança 1/.test(e.title))).toBe(true);
  });

  it("por campanha: progresso, restante, ritmo, ETA real, erros 15 min, 131026 pendentes, motivo da pausa", () => {
    const snap = buildMonitorSnapshot(baseInput());
    const c1 = snap.campaigns.find((c) => c.id === C1)!;
    expect(c1).toMatchObject({ total: 100_000, sent: 40_000, remaining: 56_000, progressPct: 44, ratePerMin: 2200, errors15m: 75, pending131026: 7, numberLabels: ["Cobrança 1"] });
    expect(c1.etaMinutes).toBeCloseTo(56_000 / 2200, 5);
    const c2 = snap.campaigns.find((c) => c.id === C2)!;
    expect(c2).toMatchObject({ status: "pausada", etaMinutes: null, pauseReason: expect.stringContaining("132001"), errors15m: 25 });
    // 'FOREIGN' não é número da conta: não aparece nos rótulos.
    expect(c1.numberLabels).not.toContain("Canal");
  });

  it("erros agrupados por código com o texto do catálogo (o que significa / o que fazer)", () => {
    const snap = buildMonitorSnapshot(baseInput());
    expect(snap.errors.map((e) => [e.code, e.count])).toEqual([[131049, 85], [null, 15]]);
    const top = snap.errors[0];
    expect(top.pct).toBe(85);
    expect(top.classe).toBe("destinatario");
    expect(top.significado).toMatch(/ecossistema|marketing/i);
    expect(top.acao.length).toBeGreaterThan(10);
    expect(top.campaigns[0]).toEqual({ id: C1, nome: "Black Friday", count: 60 });
    expect(snap.errors[1].significado).toMatch(/sem código da Meta/i);
    expect(snap.totals.errors15m).toBe(100);
  });

  it("totais: envios/min, em voo × vagas, fila restante e ETA só das campanhas em execução", () => {
    const t = buildMonitorSnapshot(baseInput()).totals;
    expect(t).toMatchObject({ sentPerMin: 2400, inFlight: 40, inFlightCap: 44, queueRemaining: 56_000, runningCampaigns: 1, pending131026: 7 });
    expect(t.sentPerMin5).toBe(2200);
    expect(t.etaMinutes).toBeCloseTo(56_000 / 2200, 5);
    expect(t.theoreticalPerMin).toBeGreaterThan(2250);
  });

  it("motor parado: campanha em execução e último tick velho (ou nenhum) ⇒ alerta crítico; sem campanha rodando ⇒ sem alerta", () => {
    const stale = buildMonitorSnapshot(baseInput({ ticks: [tick(6, { [A]: { sent: 1 } })] }));
    expect(stale.engine.stale).toBe(true);
    expect(stale.alerts[0]).toMatchObject({ id: "engine-stale", level: "critical" });
    expect(stale.engine.lastTickAgeSeconds).toBe(360);
    const none = buildMonitorSnapshot(baseInput({ ticks: [] }));
    expect(none.engine).toMatchObject({ stale: true, lastTickAt: null });
    const idle = buildMonitorSnapshot(baseInput({ ticks: [], campaigns: baseInput().campaigns.filter((c) => c.status !== "em_execucao") }));
    expect(idle.engine.stale).toBe(false);
    expect(idle.alerts.find((a) => a.id === "engine-stale")).toBeUndefined();
  });

  it("alertas: pausa automática (crítico, com o motivo), 131026 pendente (info), ordenados por gravidade", () => {
    const snap = buildMonitorSnapshot(baseInput());
    expect(snap.alerts.map((a) => a.level)).toEqual([...snap.alerts.map((a) => a.level)].sort((x, y) => ({ critical: 0, warning: 1, info: 2 })[x] - ({ critical: 0, warning: 1, info: 2 })[y]));
    const pause = snap.alerts.find((a) => a.id === `pause-${C2}`)!;
    expect(pause).toMatchObject({ level: "critical", href: `/disparador/campanhas/${C2}` });
    expect(pause.detail).toContain("34% de erro");
    expect(snap.alerts.find((a) => a.id === "pending-131026")?.title).toMatch(/7 mensagens aguardando/);
  });

  it("feed: eventos da conta com nome da campanha; evento fora da lista ignorado; mais recente primeiro", () => {
    const snap = buildMonitorSnapshot(baseInput());
    expect(snap.events.map((e) => e.type)).toEqual(["campaign_auto_paused"]);
    expect(snap.events[0].title).toBe("Campanha pausada automaticamente: Cobrança Out");
  });

  it("buraco entre ticks com campanha rodando vira evento 'motor ficou N min sem rodar'", () => {
    const snap = buildMonitorSnapshot(baseInput({ ticks: [tick(0, { [A]: { sent: 1 } }), tick(8, { [A]: { sent: 1 } })] }));
    expect(snap.events.some((e) => e.type === "tick_gap" && /8 min/.test(e.title))).toBe(true);
  });

  describe("tenancy: nada de outra conta vaza", () => {
    it("canal e campanha de outra conta presentes no cron_tick/RPC/131026 não aparecem em lugar nenhum", () => {
      const input = baseInput({
        ticks: [
          tick(0.5, { [A]: { sent: 10 }, [FOREIGN]: { sent: 5000, in_cooldown: true } }, {
            backoff_events: [
              { scope: "channel", reason: "rate_limit", session_id: FOREIGN, from: 40, to: 20 },
              { scope: "global", reason: "rss", value: 1100, from: 48, to: 24 },
            ],
          }),
        ],
      });
      const json = JSON.stringify(buildMonitorSnapshot(input));
      expect(json).not.toContain(FOREIGN);
      expect(json).not.toContain(FOREIGN_CAMPAIGN);
      expect(json).not.toContain("777331"); // o erro 131026 "estranho" do RPC foi descartado
      // O freio GLOBAL do servidor continua visível (é do motor, afeta todos).
      expect(json).toContain("Freio global do servidor");
    });
  });

  it("sem a RPC (migration 189 ausente) usa os ticks e segue funcionando", () => {
    const snap = buildMonitorSnapshot(baseInput({ counts: null, degraded: ["contagens ao vivo (migration 189 não aplicada?)"] }));
    expect(snap.degraded).toHaveLength(1);
    expect(snap.numbers[0].sent5m).toBe(3600); // soma dos ticks de 5 min
    expect(snap.numbers[0].queued).toBeNull();
    expect(snap.errors).toEqual([]);
  });
});

// ── IO: leituras sempre escopadas pela conta ──
type Call = { table: string; filters: Array<[string, unknown]> };
function fakeDb(overrides: { rpcError?: boolean } = {}) {
  const calls: Call[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rows: Record<string, unknown[]> = {
    whatsapp_config: [{ id: A, phone_number: "+5511", display_name: "Cobrança 1", provider: "meta", habilitado: true }],
    campaigns: [{ id: C1, nome: "Black Friday", status: "em_execucao", session_ids: [A], updated_at: iso(1) }],
    system_logs: [],
    dispatch_meta_131026_failures: [{ campaign_id: C1 }, { campaign_id: C1 }],
    dispatch_channel_limits: [{ session_id: A, max_in_flight: 24, hourly_limit: null }],
    dispatch_channel_cooldowns: [],
    campaign_metrics_live: [{ campaign_id: C1, total_contatos: 10, total_enviados: 4, total_entregues: 0, total_lidos: 0, total_erros: 1, total_blacklist: 0 }],
  };
  const from = (table: string) => {
    const call: Call = { table, filters: [] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit"]) b[m] = () => b;
    for (const m of ["eq", "in", "gte"]) b[m] = (col: string, val: unknown) => (call.filters.push([`${m}:${col}`, val]), b);
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
    return b;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (overrides.rpcError) return { data: null, error: { code: "PGRST202", message: "not found" } };
    return { data: { sessions: [], campaigns: [], errors: [], has_queue_index: true, has_error_code: true }, error: null };
  };
  return { db: { from, rpc } as never, calls, rpcCalls };
}

describe("loadMonitorInput / getMonitorSnapshot", () => {
  beforeEach(() => clearMonitorCache());

  it("toda leitura de tabela da conta filtra por account_id; a RPC recebe a conta e só os ids dela", async () => {
    const { db, calls, rpcCalls } = fakeDb();
    const input = await loadMonitorInput(db, "ACC-1", NOW);
    for (const table of ["whatsapp_config", "campaigns", "dispatch_meta_131026_failures"]) {
      const call = calls.find((c) => c.table === table)!;
      expect(call.filters, table).toContainEqual(["eq:account_id", "ACC-1"]);
    }
    const accountLogs = calls.filter((c) => c.table === "system_logs" && c.filters.some(([k]) => k === "in:event"));
    expect(accountLogs[0].filters).toContainEqual(["eq:account_id", "ACC-1"]);
    expect(rpcCalls).toEqual([{ fn: "dispatch_monitor_counts", args: { p_account_id: "ACC-1", p_sessions: [A], p_campaigns: [C1], p_errors_minutes: 15 } }]);
    // Limites e cooldowns só dos números da conta.
    expect(calls.find((c) => c.table === "dispatch_channel_limits")!.filters).toContainEqual(["in:session_id", [A]]);
    expect(input.pending131026.get(C1)).toBe(2);
    expect(input.metrics.get(C1)).toMatchObject({ total: 10, enviados: 4, erros: 1 });
    expect(input.limits.get(A)).toEqual({ maxInFlight: 24, hourlyLimit: null });
  });

  it("RPC ausente: degraded e o painel ainda monta", async () => {
    const { db } = fakeDb({ rpcError: true });
    const input = await loadMonitorInput(db, "ACC-1", NOW);
    expect(input.counts).toBeNull();
    expect(input.degraded.join(" ")).toMatch(/migration 189/);
    expect(buildMonitorSnapshot(input).numbers).toHaveLength(1);
  });

  it("cache de ~2,5 s por conta: várias abas = uma leitura; outra conta tem cache próprio; expira", async () => {
    const { db, rpcCalls } = fakeDb();
    let t = NOW.getTime();
    const clock = () => new Date(t);
    await Promise.all([getMonitorSnapshot(db, "ACC-1", clock), getMonitorSnapshot(db, "ACC-1", clock), getMonitorSnapshot(db, "ACC-1", clock)]);
    expect(rpcCalls).toHaveLength(1); // dedupe de requisições simultâneas
    t += 1_000;
    await getMonitorSnapshot(db, "ACC-1", clock);
    expect(rpcCalls).toHaveLength(1); // cache
    await getMonitorSnapshot(db, "ACC-2", clock);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[1].args.p_account_id).toBe("ACC-2");
    t += 3_000;
    await getMonitorSnapshot(db, "ACC-1", clock);
    expect(rpcCalls).toHaveLength(3);
  });
});
