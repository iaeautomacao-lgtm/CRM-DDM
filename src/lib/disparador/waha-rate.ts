import type { SupabaseClient } from "@supabase/supabase-js";
import { logAuditEvent } from "@/lib/audit/log-event";
import { can } from "@/lib/auth/permissions";
import type { AccountRole } from "@/lib/auth/roles";

// Ritmo do WAHA (decisão do dono 13/10, item 20; migration 338): limite de mensagens POR SEGUNDO por sessão WAHA, editável por linha em
// wacrm.dispatch_waha_rate e aplicado pelo agendador do cron (balde de fichas por número, o mesmo mecanismo da Meta). Sem linha vale o
// PADRÃO CONSERVADOR de 1 msg/s. Só o caminho WAHA: a Meta segue a regra por qualidade (channel-rate.ts) e nunca passa por aqui.

type Db = Pick<SupabaseClient, "from">;

export const DEFAULT_WAHA_RATE_PER_SECOND = 1;
export const MIN_WAHA_RATE_PER_SECOND = 0.1;
export const MAX_WAHA_RATE_PER_SECOND = 20;

/** Valor da linha → limite/s válido; ausente, inválido ou fora da faixa cai no padrão conservador. */
export function resolveWahaRate(row: { rate_per_second?: unknown } | null | undefined): number {
  const n = Number(row?.rate_per_second);
  return Number.isFinite(n) && n >= MIN_WAHA_RATE_PER_SECOND && n <= MAX_WAHA_RATE_PER_SECOND ? n : DEFAULT_WAHA_RATE_PER_SECOND;
}

/** Limite/s por sessão WAHA do tick. Nunca lança: qualquer falha (inclusive migration 338 ausente) devolve mapa vazio (= padrão de 1/s). */
export async function loadWahaRates(db: Db, sessionIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (sessionIds.length === 0) return out;
  try {
    const { data, error } = await db.from("dispatch_waha_rate").select("session_id, rate_per_second").in("session_id", sessionIds);
    if (error) {
      if (error.code !== "42P01" && error.code !== "PGRST205") console.warn("[Cron] dispatch_waha_rate indisponível; WAHA segue no padrão de 1/s:", error.message);
      return out;
    }
    for (const row of (data ?? []) as Array<{ session_id: string; rate_per_second: unknown }>) out.set(row.session_id, resolveWahaRate(row));
  } catch (err) {
    console.warn("[Cron] falha ao ler dispatch_waha_rate:", err instanceof Error ? err.message : String(err));
  }
  return out;
}

// ── tela/rota (GET e PUT /api/disparador/waha-rate) ────────────────────────
export class WahaRateError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 422 | 500 | 503 = 400,
  ) {
    super(message);
    this.name = "WahaRateError";
  }
}

export interface WahaRateActor {
  accountId: string;
  userId: string;
  role: AccountRole;
  permissions?: ReadonlySet<string>;
}

export interface WahaRateChannel {
  session_id: string;
  label: string;
  /** Limite que vale hoje (linha ou padrão). */
  rate_per_second: number;
  source: "default" | "custom";
  reason: string | null;
  updated_at: string | null;
}

export interface WahaRateView {
  default_rate_per_second: number;
  min_rate_per_second: number;
  max_rate_per_second: number;
  channels: WahaRateChannel[];
}

const missingTable = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(e.message ?? ""));

function fail(error: { message: string } | null | undefined, fallback: string): never {
  if (missingTable(error)) throw new WahaRateError("Ritmo do WAHA indisponível: aplique a migration 338.", 503);
  console.error("[WahaRate]", fallback, error?.message);
  throw new WahaRateError(fallback, 500);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadWahaChannels(db: Db, accountId: string, onlyId?: string) {
  let q = db.from("whatsapp_config").select("id, waha_session, display_phone_number, provider").eq("account_id", accountId).eq("provider", "waha");
  if (onlyId) q = q.eq("id", onlyId);
  const { data, error } = await q.limit(500);
  if (error) fail(error, "Falha ao ler os canais WAHA.");
  return (data ?? []) as Array<{ id: string; waha_session?: string | null; display_phone_number?: string | null }>;
}

export async function listWahaRates(db: Db, accountId: string): Promise<WahaRateView> {
  const channels = await loadWahaChannels(db, accountId);
  const ids = channels.map((c) => c.id);
  const rows = new Map<string, { rate_per_second: unknown; reason: string | null; updated_at: string | null }>();
  if (ids.length) {
    const { data, error } = await db.from("dispatch_waha_rate").select("session_id, rate_per_second, reason, updated_at").in("session_id", ids);
    if (error) fail(error, "Falha ao ler o ritmo do WAHA.");
    for (const r of (data ?? []) as Array<{ session_id: string; rate_per_second: unknown; reason: string | null; updated_at: string | null }>) rows.set(r.session_id, r);
  }
  return {
    default_rate_per_second: DEFAULT_WAHA_RATE_PER_SECOND,
    min_rate_per_second: MIN_WAHA_RATE_PER_SECOND,
    max_rate_per_second: MAX_WAHA_RATE_PER_SECOND,
    channels: channels.map((c) => {
      const row = rows.get(c.id);
      return {
        session_id: c.id,
        label: c.waha_session ?? c.display_phone_number ?? c.id,
        rate_per_second: resolveWahaRate(row),
        source: row ? "custom" : "default",
        reason: row?.reason ?? null,
        updated_at: row?.updated_at ?? null,
      };
    }),
  };
}

function cleanReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < 3) throw new WahaRateError("Informe o motivo da alteração (mínimo de 3 caracteres).", 422);
  if (reason.length > 500) throw new WahaRateError("Motivo longo demais (máximo de 500 caracteres).", 422);
  return reason;
}

export interface SetWahaRateInput {
  session_id: unknown;
  /** Número entre 0,1 e 20, ou null para voltar ao padrão (remove a linha). */
  rate_per_second: unknown;
  reason: unknown;
}

/** Define (ou, com null, remove) o limite/s de uma sessão WAHA da conta. Vale no próximo tick, sem restart. */
export async function setWahaRate(db: Db, actor: WahaRateActor, input: SetWahaRateInput, nowMs: number = Date.now()) {
  if (!can(actor, "campaigns.rate_limit")) throw new WahaRateError("Apenas admin ou owner alteram o ritmo do WAHA.", 403);
  const sessionId = typeof input.session_id === "string" ? input.session_id.trim().toLowerCase() : "";
  if (!UUID_RE.test(sessionId)) throw new WahaRateError("session_id inválido.", 400);
  const reason = cleanReason(input.reason);
  const reset = input.rate_per_second === null;
  const rate = typeof input.rate_per_second === "number" ? input.rate_per_second : Number(input.rate_per_second);
  if (!reset && (!Number.isFinite(rate) || rate < MIN_WAHA_RATE_PER_SECOND || rate > MAX_WAHA_RATE_PER_SECOND)) {
    throw new WahaRateError(`O ritmo do WAHA deve ficar entre ${MIN_WAHA_RATE_PER_SECOND} e ${MAX_WAHA_RATE_PER_SECOND} mensagens por segundo.`, 422);
  }

  const [channel] = await loadWahaChannels(db, actor.accountId, sessionId);
  if (!channel) throw new WahaRateError("Canal WAHA não encontrado nesta conta.", 404);
  const { data: prevRows, error: prevError } = await db.from("dispatch_waha_rate").select("rate_per_second").eq("session_id", sessionId).limit(1);
  if (prevError) fail(prevError, "Falha ao ler o ritmo atual.");
  const before = resolveWahaRate((prevRows as Array<{ rate_per_second: unknown }> | null)?.[0]);

  if (reset) {
    const del = await db.from("dispatch_waha_rate").delete().eq("session_id", sessionId).eq("account_id", actor.accountId);
    if (del.error) fail(del.error, "Falha ao voltar ao padrão.");
  } else {
    const write = await db.from("dispatch_waha_rate").upsert(
      { session_id: sessionId, account_id: actor.accountId, rate_per_second: rate, reason, updated_by: actor.userId, updated_at: new Date(nowMs).toISOString() },
      { onConflict: "session_id" },
    );
    if (write.error) fail(write.error, "Falha ao gravar o ritmo.");
  }
  const after = reset ? DEFAULT_WAHA_RATE_PER_SECOND : rate;
  await logAuditEvent({
    accountId: actor.accountId,
    eventType: "updated",
    resourceType: "dispatch_waha_rate",
    resourceId: sessionId,
    resourceLabel: channel.waha_session ?? channel.display_phone_number ?? undefined,
    action: reset ? "dispatch_waha_rate.reset" : "dispatch_waha_rate.set",
    summary: reset
      ? `Ritmo do WAHA da sessão ${channel.waha_session ?? sessionId} voltou ao padrão (${DEFAULT_WAHA_RATE_PER_SECOND}/s): ${reason}`
      : `Ritmo do WAHA da sessão ${channel.waha_session ?? sessionId} alterado de ${before}/s para ${rate}/s: ${reason}`,
    changes: { rate_per_second: { before, after } },
    metadata: { reason },
  });
  return { session_id: sessionId, rate_per_second: after, source: reset ? ("default" as const) : ("custom" as const) };
}
