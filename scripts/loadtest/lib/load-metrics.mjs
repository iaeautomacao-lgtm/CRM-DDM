// Funções puras da bancada de carga: trava de segurança do alvo, parser das métricas do tick
// (system_logs 'cron_tick') e da Meta simulada (/__stats), e formatação em tabela.

import { LOADTEST_FORBIDDEN_SUPABASE_REFS } from './forbidden.mjs';

export { LOADTEST_FORBIDDEN_SUPABASE_REFS };
const forbiddenRefIn = (text) => LOADTEST_FORBIDDEN_SUPABASE_REFS.find((ref) => String(text ?? '').toLowerCase().includes(ref));

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|host\.docker\.internal|\[?::1\]?)$/i;
export const isPrivateHostname = (hostname) => PRIVATE_HOST.test(String(hostname ?? '').trim());

/**
 * Valida as variáveis da bancada. Lança Error (mensagem em português) quando algo é inseguro.
 * Variáveis explícitas, sem herdar o .env do app:
 *   LOAD_SUPABASE_URL, LOAD_SUPABASE_SERVICE_ROLE_KEY, LOAD_ACCOUNT_ID, LOAD_USER_ID,
 *   LOAD_APP_URL, LOAD_CRON_SECRET, LOAD_API_KEY, LOAD_CONFIRM_TEST_DB=yes
 */
export function assertSafeLoadTarget(env) {
  const need = ['LOAD_SUPABASE_URL', 'LOAD_SUPABASE_SERVICE_ROLE_KEY', 'LOAD_ACCOUNT_ID', 'LOAD_USER_ID', 'LOAD_APP_URL', 'LOAD_CRON_SECRET'];
  const missing = need.filter((k) => !String(env[k] ?? '').trim());
  if (missing.length) throw new Error(`Variáveis obrigatórias ausentes: ${missing.join(', ')}`);

  const supabaseUrl = String(env.LOAD_SUPABASE_URL).trim();
  let supabase;
  try {
    supabase = new URL(supabaseUrl);
  } catch {
    throw new Error('LOAD_SUPABASE_URL não é uma URL válida');
  }
  const forbidden = forbiddenRefIn(supabaseUrl);
  if (forbidden) {
    throw new Error(`RECUSADO: LOAD_SUPABASE_URL aponta para o Supabase de PRODUÇÃO (${forbidden}). Use um projeto de teste (staging).`);
  }
  if (env.LOAD_CONFIRM_TEST_DB !== 'yes') {
    throw new Error('Confirme que o banco é de TESTE: defina LOAD_CONFIRM_TEST_DB=yes (a bancada cria canais, templates e campanhas fictícios).');
  }

  let app;
  try {
    app = new URL(String(env.LOAD_APP_URL).trim());
  } catch {
    throw new Error('LOAD_APP_URL não é uma URL válida');
  }
  if (!isPrivateHostname(app.hostname) && env.LOAD_ALLOW_REMOTE_APP !== 'true') {
    throw new Error(
      `LOAD_APP_URL (${app.hostname}) não é localhost/rede privada. Se for um app de TESTE remoto com DISPATCH_LOAD_TEST=1 e META_API_BASE_URL apontando para a Meta simulada, defina LOAD_ALLOW_REMOTE_APP=true.`,
    );
  }

  const int = (key, fallback, min, max) => {
    const n = Number.parseInt(env[key] ?? '', 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    supabaseUrl: supabase.origin,
    serviceRoleKey: String(env.LOAD_SUPABASE_SERVICE_ROLE_KEY).trim(),
    accountId: String(env.LOAD_ACCOUNT_ID).trim(),
    userId: String(env.LOAD_USER_ID).trim(),
    appUrl: app.origin,
    cronSecret: String(env.LOAD_CRON_SECRET).trim(),
    apiKey: String(env.LOAD_API_KEY ?? '').trim(),
    mockStatsUrl: String(env.LOAD_MOCK_STATS_URL ?? 'http://127.0.0.1:4010').trim().replace(/\/+$/, ''),
    channels: int('LOAD_CHANNELS', 3, 1, 50),
    itemsPerCampaign: int('LOAD_ITEMS', 5000, 1, 20_000),
    campaignsPerChannel: int('LOAD_CAMPAIGNS_PER_CHANNEL', 1, 1, 20),
    durationS: int('LOAD_DURATION_S', 300, 10, 6 * 3600),
    tickIntervalMs: int('LOAD_TICK_INTERVAL_MS', 2000, 0, 60_000),
  };
}

export function percentile(values, p) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const rank = Math.max(0, Math.ceil((p / 100) * nums.length) - 1);
  return nums[Math.min(rank, nums.length - 1)];
}

const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Linha de system_logs (event 'cron_tick') → tick normalizado. Tolera payload incompleto. */
export function parseTickRow(row) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const totals = payload.totals ?? {};
  const channels = {};
  for (const [id, c] of Object.entries(payload.channels ?? {})) {
    channels[id] = { sent: n(c?.sent), failed: n(c?.failed), peakInFlight: n(c?.peak_in_flight), inCooldown: !!c?.in_cooldown };
  }
  return {
    at: row?.created_at ?? null,
    status: String(payload.status ?? 'unknown'),
    durationMs: n(payload.duration_ms),
    sent: n(totals.sent),
    failed: n(totals.failed),
    deferred: n(totals.deferred),
    notStarted: n(totals.not_started),
    lagP99Ms: n(payload.event_loop_lag_p99_ms),
    rssMb: n(payload.rss_mb),
    rssPeakMb: n(payload.rss_peak_mb),
    globalPeakInFlight: n(payload.effective_concurrency?.global_peak_in_flight),
    metaP95Ms: n(payload.latency?.meta?.p95_ms),
    providerErrors: payload.provider_errors && typeof payload.provider_errors === 'object' ? payload.provider_errors : {},
    backoffs: Array.isArray(payload.backoff_events) ? payload.backoff_events.length : 0,
    channels,
  };
}

/** Resumo dos ticks do período (só ticks com status ok/concluído contam para duração). */
export function summarizeTicks(rows) {
  const ticks = rows.map(parseTickRow);
  const durations = ticks.map((t) => t.durationMs);
  const errors = {};
  const perChannel = {};
  for (const t of ticks) {
    for (const [code, count] of Object.entries(t.providerErrors)) errors[code] = (errors[code] ?? 0) + n(count);
    for (const [id, c] of Object.entries(t.channels)) {
      const acc = (perChannel[id] ??= { sent: 0, failed: 0, peakInFlight: 0 });
      acc.sent += c.sent;
      acc.failed += c.failed;
      acc.peakInFlight = Math.max(acc.peakInFlight, c.peakInFlight);
    }
  }
  return {
    ticks: ticks.length,
    sentTotal: ticks.reduce((a, t) => a + t.sent, 0),
    failedTotal: ticks.reduce((a, t) => a + t.failed, 0),
    tickP50Ms: percentile(durations, 50),
    tickP95Ms: percentile(durations, 95),
    tickMaxMs: durations.length ? Math.max(...durations) : 0,
    lagP99MaxMs: ticks.length ? Math.max(...ticks.map((t) => t.lagP99Ms)) : 0,
    rssPeakMb: ticks.length ? Math.max(...ticks.map((t) => Math.max(t.rssMb, t.rssPeakMb))) : 0,
    peakInFlight: ticks.length ? Math.max(...ticks.map((t) => t.globalPeakInFlight)) : 0,
    backoffEvents: ticks.reduce((a, t) => a + t.backoffs, 0),
    providerErrors: errors,
    perChannel,
  };
}

/**
 * Amostras da Meta simulada ([{ at: ms, snapshot }]) → envios/s por phone_number_id.
 * avgRps = (total_final − total_inicial) / (tempo entre as amostras); peakRps = maior rps_peak visto.
 */
export function summarizeMock(samples) {
  if (samples.length < 1) return { elapsedS: 0, phones: {}, totalRequests: 0, totalAvgRps: 0 };
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsedS = Math.max((last.at - first.at) / 1000, 0.001);
  const phones = {};
  let totalRequests = 0;
  for (const [id, s] of Object.entries(last.snapshot.phones ?? {})) {
    const startTotal = n(first.snapshot.phones?.[id]?.total);
    const delta = n(s.total) - (samples.length > 1 ? startTotal : 0);
    let peak = 0;
    let maxInFlight = 0;
    for (const sample of samples) {
      peak = Math.max(peak, n(sample.snapshot.phones?.[id]?.rps_peak));
      maxInFlight = Math.max(maxInFlight, n(sample.snapshot.phones?.[id]?.max_in_flight));
    }
    totalRequests += delta;
    phones[id] = {
      requests: delta,
      avgRps: Math.round((delta / elapsedS) * 10) / 10,
      peakRps: peak,
      maxInFlight,
      ok: n(s.ok),
      errors: s.errors ?? {},
    };
  }
  return { elapsedS: Math.round(elapsedS), phones, totalRequests, totalAvgRps: Math.round((totalRequests / elapsedS) * 10) / 10 };
}

export function formatTable(headers, rows) {
  const cells = [headers, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(cells[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

/** Linha de acompanhamento do mock (a cada 5 s no CLI). */
export function formatMockStats(snapshot) {
  const ids = Object.keys(snapshot?.phones ?? {});
  if (!ids.length) return '';
  const rows = ids.map((id) => {
    const s = snapshot.phones[id];
    return [id, s.total, s.rps_last_second, s.rps_peak, s.in_flight, Object.entries(s.errors).map(([k, v]) => `${k}:${v}`).join(' ') || '-'];
  });
  const w = snapshot.webhooks ?? {};
  return `${formatTable(['phone_number_id', 'total', 'rps(último s)', 'rps(pico)', 'em voo', 'erros'], rows)}\nwebhooks: enviados=${w.sent ?? 0} falhas=${w.failed ?? 0} descartados=${w.dropped ?? 0}`;
}
