// Saúde do número (P1-5): consulta a Meta (qualidade, tier, throughput), grava o snapshot em channel_health, recalcula o limite/s AUTOMÁTICO
// (dispatch_channel_rate, com rampa), grava o histórico e o log de mudança de qualidade. Usado por:
//   * webhook phone_number_quality_update / account_update (handleChannelHealthChange) — o webhook só dispara a re-consulta; a cor vem do Graph;
//   * poll stateless /api/disparador/health/cron (pollChannelHealth).
// Nunca assume verde: sem leitura (Graph indisponível) o número fica com a última cor conhecida por até 30 min e, depois, "desconhecido" (5/s).
// Sem as tabelas da migration 190 tudo isto é no-op (o motor segue sem limite por segundo).
//
// PAYLOAD ASSUMIDO do webhook (a Meta documenta estes campos; NÃO foi capturado um evento real nesta base — validar no primeiro evento de produção):
//   entry[].id = WABA id; entry[].changes[].field = "phone_number_quality_update";
//   value = { display_phone_number: "15550783881", event: "UPGRADE"|"DOWNGRADE"|"ONBOARDING"|"FLAGGED"|"UNFLAGGED", current_limit: "TIER_10K" }
//   field = "account_update": value = { phone_number?: "…", event: "ACCOUNT_VIOLATION"|"ACCOUNT_RESTRICTION"|"DISABLED_UPDATE"|…, … }
// O evento NÃO traz metadata.phone_number_id (por isso é tratado como evento de WABA, chave "waba:<entry.id>") e não traz a cor: re-consultamos o Graph.

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeLog } from "@/lib/logger";
import { getPhoneNumberHealth, type MetaPhoneHealth } from "@/lib/whatsapp/meta-api";
import { decryptStoredSecret } from "@/lib/whatsapp/encryption";
import {
  autoTargetRate,
  dailyLimitForTier,
  isDowngrade,
  nextAutoState,
  normalizeQuality,
  phoneDigits,
  policyFromRow,
  type Quality,
} from "@/lib/disparador/channel-rate";

type Db = Pick<SupabaseClient, "from">;

/** Quanto tempo a última cor conhecida segue valendo quando o Graph falha. */
export const HEALTH_STALE_AFTER_MS = 30 * 60 * 1000;
export const HEALTH_WEBHOOK_FIELDS = new Set(["phone_number_quality_update", "account_update"]);

export function isChannelHealthField(field: string | undefined): boolean {
  return !!field && HEALTH_WEBHOOK_FIELDS.has(field);
}

export interface HealthChannel {
  id: string;
  account_id: string;
  phone_number_id: string | null;
  access_token: string | null;
  display_phone_number?: string | null;
  waba_id?: string | null;
}

export interface HealthSnapshot {
  quality: Quality;
  tier: string | null;
  dailyLimit: number | null;
  throughputLevel: string | null;
  displayPhone: string | null;
}

export function snapshotFromGraph(data: MetaPhoneHealth): HealthSnapshot {
  const tier = data.messaging_limit_tier ?? null;
  return {
    quality: normalizeQuality(data.quality_rating),
    tier,
    dailyLimit: dailyLimitForTier(tier),
    throughputLevel: data.throughput?.level ?? null,
    displayPhone: data.display_phone_number ?? null,
  };
}

const isMissingTable = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message ?? ""));

export interface HealthRecordResult {
  skipped?: "tables_missing";
  changed: boolean;
  qualityOld: Quality | null;
  qualityNew: Quality;
  tierOld: string | null;
  tierNew: string | null;
  rateOld: number | null;
  rateNew: number;
  downgrade: boolean;
}

/** Grava a leitura (ou a falha dela), recalcula o automático e registra histórico/log. */
export async function recordChannelHealth(
  db: Db,
  input: {
    channel: Pick<HealthChannel, "id" | "account_id" | "display_phone_number">;
    snapshot: HealthSnapshot | null;
    error?: string | null;
    source: "poll" | "webhook";
    detail?: Record<string, unknown> | null;
    nowMs?: number;
  },
): Promise<HealthRecordResult> {
  const nowMs = input.nowMs ?? Date.now();
  const { channel } = input;
  const [healthRes, rateRes, policyRes] = await Promise.all([
    db.from("channel_health").select("*").eq("session_id", channel.id).limit(1),
    db.from("dispatch_channel_rate").select("*").eq("session_id", channel.id).limit(1),
    db.from("dispatch_rate_policy").select("*").eq("account_id", channel.account_id).limit(1),
  ]);
  for (const res of [healthRes, rateRes]) {
    if (isMissingTable(res.error)) {
      return { skipped: "tables_missing", changed: false, qualityOld: null, qualityNew: "UNKNOWN", tierOld: null, tierNew: null, rateOld: null, rateNew: 0, downgrade: false };
    }
    if (res.error) throw new Error(res.error.message);
  }
  const previous = (healthRes.data?.[0] ?? null) as Record<string, unknown> | null;
  const previousRate = (rateRes.data?.[0] ?? null) as Record<string, unknown> | null;
  const policy = policyFromRow(policyRes.error ? null : ((policyRes.data?.[0] ?? null) as Record<string, unknown> | null));

  const qualityOld = previous?.quality_rating ? normalizeQuality(previous.quality_rating) : previous ? "UNKNOWN" : null;
  const tierOld = (previous?.messaging_limit_tier as string | null | undefined) ?? null;
  const checkedPrev = previous?.checked_at ? Date.parse(String(previous.checked_at)) : NaN;

  // Falha do Graph: mantém a última cor conhecida (até 30 min); depois, "desconhecido". Nunca vira verde sozinho.
  let snapshot = input.snapshot;
  let lastError: string | null = null;
  if (!snapshot) {
    lastError = (input.error ?? "Graph API indisponível").slice(0, 500);
    const fresh = qualityOld && qualityOld !== "UNKNOWN" && Number.isFinite(checkedPrev) && nowMs - checkedPrev <= HEALTH_STALE_AFTER_MS;
    snapshot = {
      quality: fresh ? (qualityOld as Quality) : "UNKNOWN",
      tier: tierOld,
      dailyLimit: dailyLimitForTier(tierOld),
      throughputLevel: (previous?.throughput_level as string | null | undefined) ?? null,
      displayPhone: null,
    };
  }

  const iso = new Date(nowMs).toISOString();
  const healthRow = {
    session_id: channel.id,
    account_id: channel.account_id,
    quality_rating: snapshot.quality === "UNKNOWN" ? null : snapshot.quality,
    messaging_limit_tier: snapshot.tier,
    daily_limit: snapshot.dailyLimit,
    throughput_level: snapshot.throughputLevel,
    // Em falha preserva o instante da última leitura boa (é ele que define a validade da cor).
    checked_at: input.snapshot ? iso : ((previous?.checked_at as string | undefined) ?? iso),
    source: input.source,
    last_error: lastError,
    updated_at: iso,
  };
  const upsertHealth = await db.from("channel_health").upsert(healthRow, { onConflict: "session_id" });
  if (upsertHealth.error) {
    if (isMissingTable(upsertHealth.error)) {
      return { skipped: "tables_missing", changed: false, qualityOld, qualityNew: snapshot.quality, tierOld, tierNew: snapshot.tier, rateOld: null, rateNew: 0, downgrade: false };
    }
    throw new Error(upsertHealth.error.message);
  }

  const target = autoTargetRate(policy, snapshot.quality);
  const prevState = previousRate
    ? {
        auto_rate_per_second: Number(previousRate.auto_rate_per_second),
        auto_ramp_from: previousRate.auto_ramp_from == null ? null : Number(previousRate.auto_ramp_from),
        auto_ramp_started_at: (previousRate.auto_ramp_started_at as string | null | undefined) ?? null,
      }
    : null;
  const auto = nextAutoState(prevState, target, policy, nowMs);
  const rateOld = prevState ? prevState.auto_rate_per_second : null;
  const rateChanged =
    !prevState ||
    prevState.auto_rate_per_second !== auto.auto_rate_per_second ||
    (prevState.auto_ramp_from ?? null) !== auto.auto_ramp_from;
  if (rateChanged) {
    const write = await db.from("dispatch_channel_rate").upsert(
      { session_id: channel.id, account_id: channel.account_id, ...auto, updated_at: iso },
      { onConflict: "session_id" },
    );
    if (write.error && !isMissingTable(write.error)) throw new Error(write.error.message);
  }

  const qualityChanged = qualityOld !== snapshot.quality;
  const tierChanged = (tierOld ?? null) !== (snapshot.tier ?? null);
  const changed = qualityChanged || tierChanged || rateOld !== target;
  const downgrade = isDowngrade(qualityOld, snapshot.quality);
  if (changed) {
    await db.from("dispatch_channel_rate_history").insert({
      account_id: channel.account_id,
      session_id: channel.id,
      source: input.source,
      quality_old: qualityOld,
      quality_new: snapshot.quality,
      tier_old: tierOld,
      tier_new: snapshot.tier,
      rate_old: rateOld,
      rate_new: target,
      detail: input.detail ?? null,
    });
    void writeLog({
      account_id: channel.account_id,
      level: downgrade ? "warn" : "info",
      source: "disparador",
      event: "channel_quality_changed",
      message: `Número ${channel.display_phone_number ?? channel.id}: qualidade ${qualityOld ?? "?"} → ${snapshot.quality}; limite automático ${rateOld ?? "?"} → ${target}/s`,
      payload: {
        session_id: channel.id,
        quality_old: qualityOld,
        quality_new: snapshot.quality,
        tier_old: tierOld,
        tier_new: snapshot.tier,
        rate_old: rateOld,
        rate_new: target,
        source: input.source,
        ...(input.detail ?? {}),
      },
    });
  }

  return { changed, qualityOld, qualityNew: snapshot.quality, tierOld, tierNew: snapshot.tier, rateOld, rateNew: target, downgrade };
}

/** Consulta o Graph e grava. Nunca lança por falha da Meta (vira "desconhecido"/última cor). */
export async function refreshChannelHealth(
  db: Db,
  channel: HealthChannel,
  source: "poll" | "webhook",
  options: {
    detail?: Record<string, unknown> | null;
    nowMs?: number;
    fetchHealth?: (args: { phoneNumberId: string; accessToken: string }) => Promise<MetaPhoneHealth>;
  } = {},
): Promise<HealthRecordResult | null> {
  let snapshot: HealthSnapshot | null = null;
  let error: string | null = null;
  try {
    if (!channel.phone_number_id || !channel.access_token) throw new Error("Canal sem phone_number_id ou token");
    const token = decryptStoredSecret(channel.access_token, "whatsapp_config.access_token");
    const fetchHealth = options.fetchHealth ?? getPhoneNumberHealth;
    snapshot = snapshotFromGraph(await fetchHealth({ phoneNumberId: channel.phone_number_id, accessToken: token }));
  } catch (err) {
    // Mensagem do erro da Meta (sem token): MetaApiError não carrega credencial.
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    return await recordChannelHealth(db, { channel, snapshot, error, source, detail: options.detail, nowMs: options.nowMs });
  } catch (err) {
    console.error("[ChannelHealth] Falha ao gravar a saúde do número:", channel.id, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------- webhook ----------

/** Canais Meta da WABA (da conta): alvo do evento. */
async function wabaChannels(db: Db, accountId: string, wabaId: string): Promise<HealthChannel[]> {
  const { data, error } = await db
    .from("whatsapp_config")
    .select("id, account_id, phone_number_id, access_token, display_phone_number, waba_id, provider, habilitado")
    .eq("account_id", accountId)
    .eq("waba_id", wabaId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<HealthChannel & { provider?: string | null }>).filter((c) => (c.provider ?? "meta") === "meta");
}

/** O display do evento ("15550783881") bate com o do canal ("+1 555-078-3881")? Igual ou um sufixo do outro (mín. 8 dígitos). */
export function displayPhoneMatches(eventPhone: unknown, channelPhone: unknown): boolean {
  const a = phoneDigits(eventPhone);
  const b = phoneDigits(channelPhone);
  if (a.length < 8 || b.length < 8) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/**
 * Evento de WABA (phone_number_quality_update / account_update) → re-consulta o Graph. Resolve o número por display_phone_number dentro da WABA
 * (e da conta do canal que validou a assinatura); sem correspondência única, re-consulta TODOS os números da WABA (a cor vem do Graph, então é
 * sempre correto — só custa algumas chamadas).
 */
export async function handleChannelHealthChange(
  db: Db,
  input: { wabaId: string; accountId: string; field: string; value: Record<string, unknown> | null | undefined },
  options: { fetchHealth?: (args: { phoneNumberId: string; accessToken: string }) => Promise<MetaPhoneHealth>; nowMs?: number } = {},
): Promise<{ refreshed: string[]; matched: boolean }> {
  const value = (input.value ?? {}) as Record<string, unknown>;
  const channels = await wabaChannels(db, input.accountId, input.wabaId);
  if (channels.length === 0) {
    console.warn("[ChannelHealth] Evento de WABA sem canais Meta na conta:", input.wabaId, input.field);
    return { refreshed: [], matched: false };
  }
  const eventPhone = value.display_phone_number ?? value.phone_number;
  const matches = eventPhone ? channels.filter((c) => displayPhoneMatches(eventPhone, c.display_phone_number)) : [];
  const targets = matches.length === 1 ? matches : channels;
  const detail = {
    webhook_field: input.field,
    event: typeof value.event === "string" ? value.event : null,
    current_limit: typeof value.current_limit === "string" ? value.current_limit : null,
  };
  const refreshed: string[] = [];
  for (const channel of targets) {
    const result = await refreshChannelHealth(db, channel, "webhook", { detail, fetchHealth: options.fetchHealth, nowMs: options.nowMs });
    if (result) refreshed.push(channel.id);
  }
  return { refreshed, matched: matches.length === 1 };
}

// ---------- poll ----------

export interface PollOptions {
  /** Só re-consulta quem foi lido há mais que isto (padrão 4 min). */
  minAgeMs?: number;
  maxChannels?: number;
  concurrency?: number;
  outOfTime?: () => boolean;
  fetchHealth?: (args: { phoneNumberId: string; accessToken: string }) => Promise<MetaPhoneHealth>;
  nowMs?: number;
}

export interface PollReport {
  considered: number;
  refreshed: number;
  changed: number;
  failed: number;
  skipped_tables_missing: boolean;
}

export async function pollChannelHealth(db: Db, options: PollOptions = {}): Promise<PollReport> {
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 4 * 60 * 1000;
  const maxChannels = options.maxChannels ?? 200;
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const report: PollReport = { considered: 0, refreshed: 0, changed: 0, failed: 0, skipped_tables_missing: false };

  const { data: channelRows, error } = await db
    .from("whatsapp_config")
    .select("id, account_id, phone_number_id, access_token, display_phone_number, waba_id, provider, habilitado")
    .eq("provider", "meta")
    .eq("habilitado", true);
  if (error) throw new Error(error.message);
  const { data: healthRows, error: healthError } = await db.from("channel_health").select("session_id, checked_at, source");
  if (healthError) {
    if (isMissingTable(healthError)) return { ...report, skipped_tables_missing: true };
    throw new Error(healthError.message);
  }
  const checked = new Map((healthRows ?? []).map((r) => [String(r.session_id), Date.parse(String(r.checked_at))]));
  const due = ((channelRows ?? []) as HealthChannel[])
    .filter((c) => c.phone_number_id && c.access_token)
    .filter((c) => {
      const at = checked.get(c.id);
      return at === undefined || !Number.isFinite(at) || nowMs - at >= minAgeMs;
    })
    // Nunca lidos primeiro, depois os mais antigos.
    .sort((a, b) => (checked.get(a.id) ?? 0) - (checked.get(b.id) ?? 0))
    .slice(0, maxChannels);
  report.considered = due.length;

  let index = 0;
  const worker = async () => {
    while (index < due.length) {
      if (options.outOfTime?.()) return;
      const channel = due[index++];
      const result = await refreshChannelHealth(db, channel, "poll", { fetchHealth: options.fetchHealth, nowMs });
      if (!result) report.failed++;
      else if (result.skipped === "tables_missing") report.skipped_tables_missing = true;
      else {
        report.refreshed++;
        if (result.changed) report.changed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return report;
}
