// Controles do limite por segundo por número (P1-4/P1-5) — regras de negócio das rotas /api/disparador/rate-limits (sem Next, testável).
//
// Papéis: admin e owner leem e sobrescrevem o limite de UM número (com motivo); só OWNER marca force_above_quality e edita a política
// (% por cor, teto, rampa, confirmação da cor vermelha). Toda mudança grava histórico (imutável) + auditoria (logAuditEvent; a trigger do banco
// também audita a linha). Vale no próximo tick (≤ 60 s; com tick encadeado, em segundos), sem restart.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logAuditEvent } from "@/lib/audit/log-event";
import { can } from "@/lib/auth/permissions";
import type { AccountRole } from "@/lib/auth/roles";
import {
  autoTargetRate,
  effectiveRate,
  normalizeQuality,
  policyFromRow,
  type EffectiveRate,
  type Quality,
  type RatePolicy,
} from "@/lib/disparador/channel-rate";
import { isInCooldown } from "@/lib/disparador/throughput-config";

type Db = Pick<SupabaseClient, "from">;

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 422 | 500 | 503 = 400,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export interface RateActor {
  accountId: string;
  userId: string;
  role: AccountRole;
  /** Permissões efetivas (ctx.permissions). Sem elas, vale o papel de sistema (compat). */
  permissions?: ReadonlySet<string>;
}

// PRD 20, 20.3c: por permissão do catálogo, mesmo resultado de antes (owner/admin; owner).
//   admin ou owner      -> campaigns.rate_limit
//   só owner (política de qualidade, manter o limite acima da qualidade) -> campaigns.red_quality_override
const canRateLimit = (actor: RateActor) => can(actor, "campaigns.rate_limit");
const canOverrideQuality = (actor: RateActor) => can(actor, "campaigns.red_quality_override");
const missingTable = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(e.message ?? ""));

function fail(error: { message: string } | null | undefined, fallback: string): never {
  if (missingTable(error)) throw new RateLimitError("Limite por segundo indisponível: aplique a migration 190.", 503);
  console.error("[RateLimits]", fallback, error?.message);
  throw new RateLimitError(fallback, 500);
}

function cleanReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < 3) throw new RateLimitError("Informe o motivo da alteração (mínimo de 3 caracteres).", 422);
  if (reason.length > 500) throw new RateLimitError("Motivo longo demais (máximo de 500 caracteres).", 422);
  return reason;
}

async function loadPolicy(db: Db, accountId: string): Promise<{ policy: RatePolicy; row: Record<string, unknown> | null }> {
  const { data, error } = await db.from("dispatch_rate_policy").select("*").eq("account_id", accountId).limit(1);
  if (error) {
    if (missingTable(error)) throw new RateLimitError("Limite por segundo indisponível: aplique a migration 190.", 503);
    fail(error, "Falha ao ler a política de limites.");
  }
  const row = (data?.[0] ?? null) as Record<string, unknown> | null;
  return { policy: policyFromRow(row), row };
}

interface ChannelRow {
  id: string;
  account_id: string;
  provider: string | null;
  display_phone_number: string | null;
  phone_number_id: string | null;
}

async function loadMetaChannel(db: Db, accountId: string, sessionId: string): Promise<ChannelRow> {
  const { data, error } = await db
    .from("whatsapp_config")
    .select("id, account_id, provider, display_phone_number, phone_number_id")
    .eq("id", sessionId)
    .eq("account_id", accountId)
    .limit(1);
  if (error) fail(error, "Falha ao ler o canal.");
  const channel = (data?.[0] ?? null) as ChannelRow | null;
  if (!channel) throw new RateLimitError("Número não encontrado nesta conta.", 404);
  if ((channel.provider ?? "meta") !== "meta") throw new RateLimitError("O limite por segundo vale só para números da Meta (WAHA fica fora da regra).", 422);
  return channel;
}

export interface RateChannelView {
  session_id: string;
  display_phone_number: string | null;
  health: {
    quality_rating: Quality;
    messaging_limit_tier: string | null;
    daily_limit: number | null;
    throughput_level: string | null;
    checked_at: string | null;
    source: string | null;
    last_error: string | null;
  } | null;
  rate: {
    auto_target: number;
    auto_effective: number;
    ramping: boolean;
    manual: number | null;
    manual_reason: string | null;
    manual_set_by: string | null;
    manual_set_at: string | null;
    force_above_quality: boolean;
    effective: number;
    effective_source: EffectiveRate["source"];
    in_cooldown: boolean;
  } | null;
  /** Vermelho + política: campanha nova neste número exige confirmação do owner. */
  requires_owner_confirmation: boolean;
}

export interface RateLimitsView {
  policy: {
    green_rate: number;
    yellow_rate: number;
    red_rate: number;
    unknown_rate: number;
    max_rate_per_second: number;
    floor_rate: number;
    ramp_percent: number;
    ramp_interval_seconds: number;
    red_requires_owner_confirmation: boolean;
  };
  /** Teto físico por número (PUT valida 0 < rate ≤ teto). */
  ceiling: number;
  channels: RateChannelView[];
  /** Mudanças de qualidade das últimas 24 h ainda não reconhecidas (banner do Monitor). */
  unacknowledged: Array<Record<string, unknown>>;
}

export async function listRateLimits(db: Db, accountId: string, nowMs: number = Date.now()): Promise<RateLimitsView> {
  const { policy, row: policyRow } = await loadPolicy(db, accountId);
  const [channels, health, rates, cooldowns, history] = await Promise.all([
    db.from("whatsapp_config").select("id, account_id, provider, display_phone_number, phone_number_id, habilitado").eq("account_id", accountId).eq("provider", "meta"),
    db.from("channel_health").select("*").eq("account_id", accountId),
    db.from("dispatch_channel_rate").select("*").eq("account_id", accountId),
    db.from("dispatch_channel_cooldowns").select("session_id, cooldown_until"),
    db
      .from("dispatch_channel_rate_history")
      .select("*")
      .eq("account_id", accountId)
      .is("acknowledged_at", null)
      .gte("created_at", new Date(nowMs - 24 * 3600 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  for (const res of [channels, health, rates, history]) if (res.error) fail(res.error, "Falha ao ler os limites.");
  const healthBy = new Map((health.data ?? []).map((r) => [String(r.session_id), r as Record<string, unknown>]));
  const rateBy = new Map((rates.data ?? []).map((r) => [String(r.session_id), r as Record<string, unknown>]));
  const cooldownBy = new Map((cooldowns.error ? [] : (cooldowns.data ?? [])).map((r) => [String(r.session_id), r.cooldown_until as string | null]));

  const out: RateChannelView[] = ((channels.data ?? []) as ChannelRow[]).map((channel) => {
    const h = healthBy.get(channel.id);
    const r = rateBy.get(channel.id);
    const quality = h ? normalizeQuality(h.quality_rating) : null;
    let rateView: RateChannelView["rate"] = null;
    if (r) {
      const eff = effectiveRate(
        {
          auto_rate_per_second: Number(r.auto_rate_per_second),
          auto_ramp_from: r.auto_ramp_from == null ? null : Number(r.auto_ramp_from),
          auto_ramp_started_at: (r.auto_ramp_started_at as string | null) ?? null,
          manual_rate_per_second: r.manual_rate_per_second == null ? null : Number(r.manual_rate_per_second),
          force_above_quality: r.force_above_quality === true,
        },
        policy,
        nowMs,
        { inCooldown: isInCooldown(channel.id, nowMs, cooldownBy.get(channel.id)) },
      );
      rateView = {
        auto_target: eff.target,
        auto_effective: eff.auto,
        ramping: eff.ramping,
        manual: r.manual_rate_per_second == null ? null : Number(r.manual_rate_per_second),
        manual_reason: (r.manual_reason as string | null) ?? null,
        manual_set_by: (r.manual_set_by as string | null) ?? null,
        manual_set_at: (r.manual_set_at as string | null) ?? null,
        force_above_quality: r.force_above_quality === true,
        effective: eff.rate,
        effective_source: eff.source,
        in_cooldown: eff.inCooldown,
      };
    }
    return {
      session_id: channel.id,
      display_phone_number: channel.display_phone_number,
      health: h
        ? {
            quality_rating: quality ?? "UNKNOWN",
            messaging_limit_tier: (h.messaging_limit_tier as string | null) ?? null,
            daily_limit: h.daily_limit == null ? null : Number(h.daily_limit),
            throughput_level: (h.throughput_level as string | null) ?? null,
            checked_at: (h.checked_at as string | null) ?? null,
            source: (h.source as string | null) ?? null,
            last_error: (h.last_error as string | null) ?? null,
          }
        : null,
      rate: rateView,
      requires_owner_confirmation: policy.redRequiresOwnerConfirmation && quality === "RED",
    };
  });

  return {
    policy: {
      green_rate: policy.green,
      yellow_rate: policy.yellow,
      red_rate: policy.red,
      unknown_rate: policy.unknown,
      max_rate_per_second: policy.max,
      floor_rate: policy.floor,
      ramp_percent: policy.rampPercent,
      ramp_interval_seconds: policy.rampIntervalSeconds,
      red_requires_owner_confirmation: policy.redRequiresOwnerConfirmation,
    },
    ceiling: policy.max,
    channels: out,
    unacknowledged: (history.data ?? []) as Array<Record<string, unknown>>,
    ...(policyRow ? {} : {}),
  };
}

export interface SetManualInput {
  session_id: unknown;
  rate_per_second: unknown;
  reason: unknown;
  force_above_quality?: unknown;
}

/** Sobrescreve o limite/s de um número (manual). */
export async function setManualRate(db: Db, actor: RateActor, input: SetManualInput, nowMs: number = Date.now()) {
  if (!canRateLimit(actor)) throw new RateLimitError("Apenas admin ou owner alteram o limite por segundo.", 403);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new RateLimitError("session_id inválido.", 400);
  const reason = cleanReason(input.reason);
  const rate = typeof input.rate_per_second === "number" ? input.rate_per_second : Number(input.rate_per_second);
  const force = input.force_above_quality === true;
  if (force && !canOverrideQuality(actor)) throw new RateLimitError("Somente o owner pode manter o limite acima da qualidade (force_above_quality).", 403);

  const channel = await loadMetaChannel(db, actor.accountId, sessionId);
  const { policy } = await loadPolicy(db, actor.accountId);
  if (!Number.isFinite(rate) || rate <= 0) throw new RateLimitError("O limite por segundo deve ser maior que zero.", 422);
  if (rate > policy.max) throw new RateLimitError(`O limite por segundo não pode passar do teto do número (${policy.max}/s).`, 422);

  const [healthRes, rateRes] = await Promise.all([
    db.from("channel_health").select("quality_rating, messaging_limit_tier").eq("session_id", sessionId).limit(1),
    db.from("dispatch_channel_rate").select("*").eq("session_id", sessionId).limit(1),
  ]);
  if (healthRes.error) fail(healthRes.error, "Falha ao ler a saúde do número.");
  if (rateRes.error) fail(rateRes.error, "Falha ao ler o limite do número.");
  const health = (healthRes.data?.[0] ?? null) as Record<string, unknown> | null;
  const previous = (rateRes.data?.[0] ?? null) as Record<string, unknown> | null;
  const quality = normalizeQuality(health?.quality_rating);
  const iso = new Date(nowMs).toISOString();

  const row = {
    session_id: sessionId,
    account_id: actor.accountId,
    // Número ainda sem automático: nasce com o alvo da qualidade conhecida (nunca verde sem leitura).
    auto_rate_per_second: previous ? Number(previous.auto_rate_per_second) : autoTargetRate(policy, quality),
    manual_rate_per_second: rate,
    manual_reason: reason,
    manual_set_by: actor.userId,
    manual_set_at: iso,
    force_above_quality: force,
    updated_at: iso,
  };
  const write = await db.from("dispatch_channel_rate").upsert(row, { onConflict: "session_id" });
  if (write.error) fail(write.error, "Falha ao gravar o limite.");

  const oldManual = previous?.manual_rate_per_second == null ? null : Number(previous.manual_rate_per_second);
  await db.from("dispatch_channel_rate_history").insert({
    account_id: actor.accountId,
    session_id: sessionId,
    source: "admin",
    quality_old: health ? quality : null,
    quality_new: health ? quality : null,
    tier_old: (health?.messaging_limit_tier as string | null | undefined) ?? null,
    tier_new: (health?.messaging_limit_tier as string | null | undefined) ?? null,
    rate_old: oldManual ?? (previous ? Number(previous.auto_rate_per_second) : null),
    rate_new: rate,
    actor_id: actor.userId,
    reason,
    detail: { force_above_quality: force },
  });
  await logAuditEvent({
    accountId: actor.accountId,
    eventType: "updated",
    resourceType: "dispatch_channel_rate",
    resourceId: sessionId,
    resourceLabel: channel.display_phone_number ?? channel.phone_number_id ?? undefined,
    action: "dispatch_rate.manual_set",
    summary: `Limite por segundo do número ${channel.display_phone_number ?? sessionId} definido manualmente em ${rate}/s${force ? " (acima da qualidade)" : ""}: ${reason}`,
    changes: { manual_rate_per_second: { before: oldManual, after: rate }, force_above_quality: { before: previous?.force_above_quality === true, after: force } },
    metadata: { reason, quality },
  });
  return { session_id: sessionId, manual_rate_per_second: rate, force_above_quality: force, quality };
}

/** "Voltar ao automático": remove o manual e a trava force_above_quality. */
export async function revertToAuto(db: Db, actor: RateActor, sessionId: string, reasonRaw?: unknown, nowMs: number = Date.now()) {
  if (!canRateLimit(actor)) throw new RateLimitError("Apenas admin ou owner alteram o limite por segundo.", 403);
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new RateLimitError("session_id inválido.", 400);
  const reason = reasonRaw == null || reasonRaw === "" ? "Voltar ao automático" : cleanReason(reasonRaw);
  const channel = await loadMetaChannel(db, actor.accountId, sessionId);
  const { data, error } = await db.from("dispatch_channel_rate").select("*").eq("session_id", sessionId).limit(1);
  if (error) fail(error, "Falha ao ler o limite do número.");
  const previous = (data?.[0] ?? null) as Record<string, unknown> | null;
  if (!previous || previous.manual_rate_per_second == null) throw new RateLimitError("Este número já está no automático.", 409);

  const iso = new Date(nowMs).toISOString();
  const update = await db
    .from("dispatch_channel_rate")
    .update({
      manual_rate_per_second: null,
      manual_reason: null,
      manual_set_by: null,
      manual_set_at: null,
      force_above_quality: false,
      updated_at: iso,
    })
    .eq("session_id", sessionId);
  if (update.error) fail(update.error, "Falha ao voltar ao automático.");
  await db.from("dispatch_channel_rate_history").insert({
    account_id: actor.accountId,
    session_id: sessionId,
    source: "revert_auto",
    rate_old: Number(previous.manual_rate_per_second),
    rate_new: Number(previous.auto_rate_per_second),
    actor_id: actor.userId,
    reason,
  });
  await logAuditEvent({
    accountId: actor.accountId,
    eventType: "updated",
    resourceType: "dispatch_channel_rate",
    resourceId: sessionId,
    resourceLabel: channel.display_phone_number ?? undefined,
    action: "dispatch_rate.reverted_to_auto",
    summary: `Limite por segundo do número ${channel.display_phone_number ?? sessionId} voltou ao automático: ${reason}`,
    changes: { manual_rate_per_second: { before: Number(previous.manual_rate_per_second), after: null } },
    metadata: { reason },
  });
  return { session_id: sessionId, manual_rate_per_second: null };
}

export interface PolicyInput {
  green_rate?: unknown;
  yellow_rate?: unknown;
  red_rate?: unknown;
  unknown_rate?: unknown;
  max_rate_per_second?: unknown;
  floor_rate?: unknown;
  ramp_percent?: unknown;
  ramp_interval_seconds?: unknown;
  red_requires_owner_confirmation?: unknown;
}

const POLICY_NUMBER_FIELDS: Array<[keyof PolicyInput, number, number, boolean]> = [
  // campo, mínimo, máximo, inteiro?
  ["green_rate", 0.01, 1000, false],
  ["yellow_rate", 0.01, 1000, false],
  ["red_rate", 0.01, 1000, false],
  ["unknown_rate", 0.01, 1000, false],
  ["max_rate_per_second", 0.01, 1000, false],
  ["floor_rate", 0.01, 1000, false],
  ["ramp_percent", 1, 400, true],
  ["ramp_interval_seconds", 10, 3600, true],
];

/** Política da conta (% por cor, teto, rampa, confirmação do vermelho) — só OWNER. */
export async function updatePolicy(db: Db, actor: RateActor, input: PolicyInput, reasonRaw: unknown, nowMs: number = Date.now()) {
  if (!canOverrideQuality(actor)) throw new RateLimitError("Somente o owner edita a política de limites por qualidade.", 403);
  const reason = cleanReason(reasonRaw);
  const { row: existing } = await loadPolicy(db, actor.accountId);
  const patch: Record<string, unknown> = {};
  for (const [field, min, max, integer] of POLICY_NUMBER_FIELDS) {
    if (input[field] === undefined) continue;
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new RateLimitError(`Valor inválido para ${field} (entre ${min} e ${max}${integer ? ", inteiro" : ""}).`, 422);
    }
    patch[field] = value;
  }
  if (input.red_requires_owner_confirmation !== undefined) {
    if (typeof input.red_requires_owner_confirmation !== "boolean") throw new RateLimitError("red_requires_owner_confirmation deve ser booleano.", 422);
    patch.red_requires_owner_confirmation = input.red_requires_owner_confirmation;
  }
  if (Object.keys(patch).length === 0) throw new RateLimitError("Nenhum campo da política para alterar.", 400);
  const merged = { ...(existing ?? {}), ...patch };
  const next = policyFromRow(merged);
  if (!(next.red <= next.yellow && next.yellow <= next.green)) throw new RateLimitError("A ordem deve ser vermelho ≤ amarelo ≤ verde.", 422);
  if (next.green > next.max) throw new RateLimitError("O limite do verde não pode passar do teto por número.", 422);

  const write = await db
    .from("dispatch_rate_policy")
    .upsert({ account_id: actor.accountId, ...patch, updated_by: actor.userId, updated_at: new Date(nowMs).toISOString() }, { onConflict: "account_id" });
  if (write.error) fail(write.error, "Falha ao gravar a política.");
  await db.from("dispatch_channel_rate_history").insert({
    account_id: actor.accountId,
    session_id: "00000000-0000-0000-0000-000000000000",
    source: "policy",
    actor_id: actor.userId,
    reason,
    detail: { patch },
  });
  await logAuditEvent({
    accountId: actor.accountId,
    eventType: "updated",
    resourceType: "dispatch_rate_policy",
    resourceId: actor.accountId,
    resourceLabel: "Política de limites por qualidade",
    action: "dispatch_rate.policy_updated",
    summary: `Política de limite por segundo alterada (${Object.keys(patch).join(", ")}): ${reason}`,
    changes: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { before: existing?.[k] ?? null, after: v }])),
    metadata: { reason },
  });
  return { policy: patch };
}

/** "Reconhecer" nos avisos de queda de qualidade (admin ou owner). */
export async function acknowledgeHistory(db: Db, actor: RateActor, ids: unknown, nowMs: number = Date.now()) {
  if (!canRateLimit(actor)) throw new RateLimitError("Apenas admin ou owner reconhecem avisos.", 403);
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new RateLimitError("Informe de 1 a 100 ids de aviso (UUID).", 400);
  }
  const { data, error } = await db
    .from("dispatch_channel_rate_history")
    .update({ acknowledged_by: actor.userId, acknowledged_at: new Date(nowMs).toISOString() })
    .eq("account_id", actor.accountId)
    .is("acknowledged_at", null)
    .in("id", ids as string[])
    .select("id");
  if (error) fail(error, "Falha ao reconhecer os avisos.");
  return { acknowledged: (data ?? []).length };
}

/**
 * Número em vermelho: iniciar campanha nova exige confirmação do OWNER (decisão do dono). Devolve os números bloqueados para o caller.
 * Sem as tabelas da 190 (ou sem leitura) → nada bloqueado (inerte).
 */
export async function redChannelsNeedingOwner(db: Db, accountId: string, sessionIds: string[]): Promise<string[]> {
  if (sessionIds.length === 0) return [];
  const [policyRes, healthRes] = await Promise.all([
    db.from("dispatch_rate_policy").select("*").eq("account_id", accountId).limit(1),
    db.from("channel_health").select("session_id, quality_rating").eq("account_id", accountId).in("session_id", sessionIds),
  ]);
  if (policyRes.error || healthRes.error) return [];
  const policy = policyFromRow((policyRes.data?.[0] ?? null) as Record<string, unknown> | null);
  if (!policy.redRequiresOwnerConfirmation) return [];
  return (healthRes.data ?? []).filter((h) => normalizeQuality(h.quality_rating) === "RED").map((h) => String(h.session_id));
}
