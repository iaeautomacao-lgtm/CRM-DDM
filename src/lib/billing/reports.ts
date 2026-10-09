import "server-only";
// PRD 17, PR 17.6 — relatório por período ("pago após cobrança") e alertas da régua de cobrança.
// Só leitura; tudo filtrado pela conta da sessão. Sem CPF/telefone/texto: contagens e ids. Os números e o que significam estão definidos no
// cabeçalho da migration 320 ("paga após cobrança" = pagamento DETECTADO depois de uma etapa enviada; correlação, não causa).
import { findRedChannels } from "@/lib/disparador/red-quality-gate";
import { badRequest, notFound } from "@/lib/api/v1/respond";

import { getRuler, parseCivilDate, unavailable, type Db } from "./ruler-api";

export const REPORT_MAX_DAYS = 93;
export const REPORT_DEFAULT_DAYS = 30;

/** Limiares dos alertas (PRD 17 §10). */
export const SYNC_STALE_AFTER_MS = 60 * 60_000;
export const RESERVED_STUCK_AFTER_S = 15 * 60;
export const DEFERRED_RATE_THRESHOLD = 0.2;
/** Janela dos logs de tick usada na taxa de adiadas (o cron roda a cada ~1 min). */
export const DEFERRED_WINDOW_MS = 60 * 60_000;
/** Menos consultas que isto na janela = amostra pequena demais para alertar. */
export const DEFERRED_MIN_SAMPLE = 20;

const DAY_MS = 86_400_000;

/** Data civil de Brasília (UTC-3 fixo) a partir de um instante. */
export function brasiliaDay(now: Date): string {
  return new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

/** from/to opcionais: padrão = últimos 30 dias até hoje (Brasília); to < from ou período > 93 dias = 400. */
export function parseReportRange(from: string | null, to: string | null, now: Date = new Date()): { from: string; to: string } {
  const end = to ? parseCivilDate(to, "to") : brasiliaDay(now);
  const start = from ? parseCivilDate(from, "from") : new Date(Date.parse(`${end}T00:00:00Z`) - (REPORT_DEFAULT_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
  if (days < 0) throw badRequest("to deve ser igual ou depois de from");
  if (days > REPORT_MAX_DAYS - 1) throw badRequest(`O período máximo é de ${REPORT_MAX_DAYS} dias`);
  return { from: start, to: end };
}

export interface RulerReport {
  ruler_id: string;
  from: string;
  to: string;
  steps: Array<{ step_id: string; position: number; offset_days: number | null; active: boolean; sent: number; delivered: number; read: number; replied: number; errors: number; paid_after: number }>;
  totals: { sent: number; delivered: number; read: number; replied: number; errors: number };
  payments: { paid_after_charge: number; paid_without_charge: number; avg_charges_before_payment: number | null; by_charges: Array<{ charges: number; total: number }> };
  daily: Array<{ day: string; sent: number; paid_after: number }>;
}

export async function rulerReport(db: Db, accountId: string, rulerId: string, range: { from: string; to: string }): Promise<RulerReport> {
  await getRuler(db, accountId, rulerId); // 404 para régua de outra conta
  const { data, error } = await db.rpc("billing_ruler_report", { p_account: accountId, p_ruler: rulerId, p_from: range.from, p_to: range.to });
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("range_invalid")) throw badRequest("Período inválido");
    if (msg.includes("ruler_not_found")) throw notFound("Régua não encontrada");
    throw unavailable(error, "Relatório");
  }
  const r = data as RulerReport | null;
  if (!r) throw unavailable(null, "Relatório");
  const n = (v: unknown) => Number(v ?? 0);
  return {
    ruler_id: rulerId,
    from: range.from,
    to: range.to,
    steps: (r.steps ?? []).map((s) => ({ ...s, sent: n(s.sent), delivered: n(s.delivered), read: n(s.read), replied: n(s.replied), errors: n(s.errors), paid_after: n(s.paid_after) })),
    totals: { sent: n(r.totals?.sent), delivered: n(r.totals?.delivered), read: n(r.totals?.read), replied: n(r.totals?.replied), errors: n(r.totals?.errors) },
    payments: {
      paid_after_charge: n(r.payments?.paid_after_charge),
      paid_without_charge: n(r.payments?.paid_without_charge),
      avg_charges_before_payment: r.payments?.avg_charges_before_payment === null || r.payments?.avg_charges_before_payment === undefined ? null : Number(r.payments.avg_charges_before_payment),
      by_charges: (r.payments?.by_charges ?? []).map((c) => ({ charges: n(c.charges), total: n(c.total) })),
    },
    daily: (r.daily ?? []).map((d) => ({ day: String(d.day), sent: n(d.sent), paid_after: n(d.paid_after) })),
  };
}

// ---- alertas -----------------------------------------------------------------------------------------------------------------------
export type AlertCode = "sync_never_succeeded" | "sync_stale" | "reserved_stuck" | "deferred_rate_high" | "ruler_without_channel" | "ruler_channel_disabled" | "ruler_channel_red";

export interface BillingAlert {
  code: AlertCode;
  severity: "warning" | "critical";
  message: string;
  /** Só ids/contagens (nunca dado pessoal). */
  detail: Record<string, unknown>;
}

interface AlertStats {
  reserved_stuck: number;
  oldest_reserved_s: number | null;
  sync: Array<{ source: string; last_success_at: string | null; last_run_at: string | null; last_error: string | null }>;
  live_rulers: Array<{ id: string; name: string; channel_id: string | null }>;
  open_debts: number;
}

/** Taxa de consultas adiadas (falha da DDM) nos ticks recentes do log do motor. Sem amostra suficiente ⇒ null. */
export function deferredRate(ticks: Array<{ payload?: { precheck?: { checked?: number; deferred?: number } } | null }>): { rate: number; sample: number } | null {
  let checked = 0;
  let deferred = 0;
  for (const t of ticks) {
    checked += Number(t.payload?.precheck?.checked ?? 0);
    deferred += Number(t.payload?.precheck?.deferred ?? 0);
  }
  const sample = checked + deferred;
  return sample >= DEFERRED_MIN_SAMPLE ? { rate: deferred / sample, sample } : null;
}

export interface AlertDeps {
  now?: () => Date;
  redChannels?: (db: Db, accountId: string, channelIds: string[]) => Promise<Array<{ id: string }>>;
}

export async function billingAlerts(db: Db, accountId: string, deps: AlertDeps = {}): Promise<{ generated_at: string; alerts: BillingAlert[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const { data, error } = await db.rpc("billing_alert_stats", { p_account: accountId });
  if (error) throw unavailable(error, "Alertas");
  const stats = (data ?? {}) as Partial<AlertStats>;
  const alerts: BillingAlert[] = [];
  const liveRulers = stats.live_rulers ?? [];

  // 1) sincronização: só importa se há régua ligada (fora do dry-run) ou dívida aberta acompanhada
  if (liveRulers.length > 0) {
    for (const s of stats.sync ?? []) {
      const last = s.last_success_at ? Date.parse(s.last_success_at) : null;
      if (last === null) alerts.push({ code: "sync_never_succeeded", severity: "critical", message: `A sincronização da fonte "${s.source}" nunca teve sucesso.`, detail: { source: s.source, last_error: s.last_error } });
      else if (now.getTime() - last > SYNC_STALE_AFTER_MS) {
        alerts.push({ code: "sync_stale", severity: "critical", message: `A sincronização da fonte "${s.source}" não tem sucesso há mais de 1 hora.`, detail: { source: s.source, last_success_at: s.last_success_at, last_error: s.last_error } });
      }
    }
  }

  // 2) etapas reservadas e não enfileiradas há > 15 min
  if (Number(stats.reserved_stuck ?? 0) > 0) {
    alerts.push({
      code: "reserved_stuck",
      severity: "warning",
      message: `${stats.reserved_stuck} etapa(s) reservada(s) há mais de 15 minutos sem entrar na fila.`,
      detail: { count: Number(stats.reserved_stuck), oldest_s: stats.oldest_reserved_s ?? null },
    });
  }

  // 3) taxa de consultas adiadas por falha da DDM (log do tick do motor; o cron é global, então a taxa é do sistema)
  if (liveRulers.length > 0) {
    const since = new Date(now.getTime() - DEFERRED_WINDOW_MS).toISOString();
    const { data: logs, error: le } = await db.from("system_logs").select("payload").eq("event", "billing_tick").gte("created_at", since).limit(120);
    if (!le) {
      const dr = deferredRate((logs ?? []) as Array<{ payload: { precheck?: { checked?: number; deferred?: number } } | null }>);
      if (dr && dr.rate > DEFERRED_RATE_THRESHOLD) {
        alerts.push({ code: "deferred_rate_high", severity: "warning", message: `${Math.round(dr.rate * 100)}% das consultas à DDM na última hora foram adiadas por falha.`, detail: { rate: Number(dr.rate.toFixed(3)), sample: dr.sample } });
      }
    }
  }

  // 4) régua ligada sem canal saudável (sem canal, canal desabilitado ou número em qualidade vermelha)
  if (liveRulers.length > 0) {
    const channelIds = [...new Set(liveRulers.map((r) => r.channel_id).filter((c): c is string => !!c))];
    const enabled = new Map<string, boolean>();
    if (channelIds.length > 0) {
      const { data: ch } = await db.from("whatsapp_config").select("id, habilitado").eq("account_id", accountId).in("id", channelIds);
      for (const c of (ch ?? []) as Array<{ id: string; habilitado: boolean | null }>) enabled.set(c.id, c.habilitado !== false);
    }
    const red = new Set((await (deps.redChannels ?? ((d, a, ids) => findRedChannels(d as never, a, ids)))(db, accountId, channelIds).catch(() => [])).map((c) => c.id));
    for (const r of liveRulers) {
      if (!r.channel_id || !enabled.has(r.channel_id)) alerts.push({ code: "ruler_without_channel", severity: "critical", message: `A régua "${r.name}" está ligada sem um canal válido.`, detail: { ruler_id: r.id } });
      else if (enabled.get(r.channel_id) === false) alerts.push({ code: "ruler_channel_disabled", severity: "critical", message: `O canal da régua "${r.name}" está desabilitado.`, detail: { ruler_id: r.id, channel_id: r.channel_id } });
      else if (red.has(r.channel_id)) alerts.push({ code: "ruler_channel_red", severity: "warning", message: `O número da régua "${r.name}" está com qualidade vermelha na Meta: a régua não envia por ele sozinha.`, detail: { ruler_id: r.id, channel_id: r.channel_id } });
    }
  }

  return { generated_at: now.toISOString(), alerts };
}
