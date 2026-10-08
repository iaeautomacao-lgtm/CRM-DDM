// Controles por número do Disparador (P1-6a): ler e editar dispatch_channel_limits pelo front.
//   - max_in_flight (vagas): 1..150 na Meta, 1..50 na WAHA (teto próprio — risco de banimento);
//   - hourly_limit: inteiro > 0 ou vazio (sem limite do canal);
//   - paused (migration 192): o claim não pega itens do número; nada é cancelado.
// Toda mudança exige motivo, confirmação e grava logAuditEvent com o "antes → depois". Vale no próximo tick:
// o cron lê a linha do canal a cada tick (sem restart). Os globais (env) são só leitura.
//
// O limite por segundo / qualidade (P1-5, migration 190, PR #140) é do rate-limits-service: aqui só LEMOS
// (`loadRateInfo`) para a tela; as escritas vão direto em /api/disparador/rate-limits.

import {
  MAX_PER_NUMBER_CONCURRENCY,
  MAX_WAHA_PER_NUMBER_CONCURRENCY,
  resolveThroughputConfig,
  type DispatchProvider,
} from "./throughput-config";
import { isTickChainEnabled } from "./tick-chain";
import { isBatchClaimEnabled } from "./batch-claim";
import { listRateLimits } from "./rate-limits-service";
import { loadChannelIdentities, type ChannelIdentity } from "./channel-label";

export class LimitsInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_HOURLY_LIMIT = 1_000_000;
export const REASON_MIN = 5;
export const REASON_MAX = 300;
export const AUDIT_RESOURCE = "dispatch_channel_limits";
export const HISTORY_LIMIT = 50;

/** Teto de vagas do número conforme o provedor (desconhecido segue o teto conservador da WAHA). */
export function maxInFlightCeiling(provider: DispatchProvider | "unknown" | null | undefined): number {
  return provider === "meta" ? MAX_PER_NUMBER_CONCURRENCY : MAX_WAHA_PER_NUMBER_CONCURRENCY;
}

// ── validação do PUT ─────────────────────────────────────────────────────
export interface LimitsValues {
  maxInFlight: number | null;
  hourlyLimit: number | null;
  paused: boolean;
}

export interface LimitsPatch {
  maxInFlight?: number;
  /** null = remover o limite por hora do canal. */
  hourlyLimit?: number | null;
  paused?: boolean;
}

export interface LimitsRequest {
  sessionId: string;
  patch: LimitsPatch;
  reason: string;
  /** Valores que a tela mostrou como "antes": se mudaram no banco, a escrita é recusada (409). */
  expected: Partial<LimitsValues> | null;
}

function asInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new LimitsInputError(`"${field}" deve ser um número inteiro.`);
  return value;
}

export function parseLimitsRequest(body: unknown): LimitsRequest {
  if (!body || typeof body !== "object") throw new LimitsInputError("Corpo inválido.");
  const b = body as Record<string, unknown>;

  const sessionId = typeof b.sessionId === "string" ? b.sessionId.trim().toLowerCase() : "";
  if (!UUID_RE.test(sessionId)) throw new LimitsInputError('"sessionId" inválido.');

  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < REASON_MIN) throw new LimitsInputError(`Informe o motivo da mudança (mínimo ${REASON_MIN} caracteres).`);
  if (reason.length > REASON_MAX) throw new LimitsInputError(`O motivo é longo demais (máximo ${REASON_MAX} caracteres).`);

  if (b.confirm !== true) throw new LimitsInputError("A mudança precisa ser confirmada.");

  const patch: LimitsPatch = {};
  if (b.maxInFlight !== undefined) patch.maxInFlight = asInt(b.maxInFlight, "maxInFlight");
  if (b.hourlyLimit !== undefined) {
    if (b.hourlyLimit === null) patch.hourlyLimit = null;
    else {
      const n = asInt(b.hourlyLimit, "hourlyLimit");
      if (n < 1 || n > MAX_HOURLY_LIMIT) throw new LimitsInputError(`"hourlyLimit" deve estar entre 1 e ${MAX_HOURLY_LIMIT.toLocaleString("pt-BR")} (ou vazio para sem limite).`);
      patch.hourlyLimit = n;
    }
  }
  if (b.paused !== undefined) {
    if (typeof b.paused !== "boolean") throw new LimitsInputError('"paused" deve ser verdadeiro ou falso.');
    patch.paused = b.paused;
  }
  if (Object.keys(patch).length === 0) throw new LimitsInputError("Nada para alterar.");

  let expected: LimitsRequest["expected"] = null;
  if (b.expected && typeof b.expected === "object") {
    const e = b.expected as Record<string, unknown>;
    expected = {};
    if (e.maxInFlight === null || typeof e.maxInFlight === "number") expected.maxInFlight = e.maxInFlight as number | null;
    if (e.hourlyLimit === null || typeof e.hourlyLimit === "number") expected.hourlyLimit = e.hourlyLimit as number | null;
    if (typeof e.paused === "boolean") expected.paused = e.paused;
  }
  return { sessionId, patch, reason, expected };
}

/** Faixa do número conforme o provedor. Lança LimitsInputError. */
export function validatePatchForProvider(patch: LimitsPatch, provider: DispatchProvider | "unknown" | null): void {
  if (patch.maxInFlight !== undefined) {
    const ceiling = maxInFlightCeiling(provider);
    if (patch.maxInFlight < 1 || patch.maxInFlight > ceiling) {
      throw new LimitsInputError(
        `Vagas por número: de 1 a ${ceiling}${provider === "meta" ? "" : " (WAHA tem teto próprio, menor que o da Meta)"}.`,
      );
    }
  }
}

export interface Change {
  field: "max_in_flight" | "hourly_limit" | "paused";
  before: unknown;
  after: unknown;
}

/** Diferenças reais entre o estado atual e o pedido (campo igual não entra no "antes → depois"). */
export function diffLimits(current: LimitsValues, patch: LimitsPatch): Change[] {
  const out: Change[] = [];
  if (patch.maxInFlight !== undefined && patch.maxInFlight !== current.maxInFlight) {
    out.push({ field: "max_in_flight", before: current.maxInFlight, after: patch.maxInFlight });
  }
  if (patch.hourlyLimit !== undefined && patch.hourlyLimit !== current.hourlyLimit) {
    out.push({ field: "hourly_limit", before: current.hourlyLimit, after: patch.hourlyLimit });
  }
  if (patch.paused !== undefined && patch.paused !== current.paused) {
    out.push({ field: "paused", before: current.paused, after: patch.paused });
  }
  return out;
}

const FIELD_LABEL: Record<Change["field"], string> = {
  max_in_flight: "vagas",
  hourly_limit: "limite por hora",
  paused: "pausa",
};
function fmtVal(c: Change, v: unknown): string {
  if (c.field === "paused") return v ? "pausado" : "ativo";
  return v === null || v === undefined ? "padrão/sem limite" : String(v);
}
export function summarizeChanges(label: string, changes: Change[]): string {
  return `Número ${label}: ${changes.map((c) => `${FIELD_LABEL[c.field]} ${fmtVal(c, c.before)} → ${fmtVal(c, c.after)}`).join("; ")}`;
}

// ── acesso ao banco (tipos mínimos) ──────────────────────────────────────
interface Q {
  select(cols: string): Q;
  eq(col: string, v: unknown): Q;
  in(col: string, v: unknown[]): Q;
  order(col: string, o?: { ascending?: boolean }): Q;
  limit(n: number): Q;
  update(values: Record<string, unknown>): Q;
  insert(values: Record<string, unknown>): Q;
  then: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>["then"];
}
export interface LimitsDb {
  from(table: string): Q;
}
type DbResult<T> = { data: T | null; error: { message: string; code?: string } | null };
async function run<T>(q: unknown): Promise<DbResult<T>> {
  return (await (q as PromiseLike<DbResult<T>>)) as DbResult<T>;
}
const isMissingColumn = (e: { code?: string } | null) => e?.code === "42703" || e?.code === "PGRST204";

export interface NumberLimits {
  id: string;
  label: string;
  phone: string | null;
  provider: DispatchProvider | "unknown";
  enabled: boolean;
  /** Último poll de saúde na Meta: true = conectado, false = desconectado (ver connectionError), null = sem leitura. */
  connected: boolean | null;
  connectionError: string | null;
  /** Valor da linha do banco (null = sem linha: vale o padrão do provedor). */
  maxInFlight: number | null;
  /** Vagas que valem hoje (linha ou padrão do provedor). */
  effectiveMaxInFlight: number;
  defaultMaxInFlight: number;
  maxAllowed: number;
  hourlyLimit: number | null;
  paused: boolean;
  hasRow: boolean;
  activeCampaigns: Array<{ id: string; nome: string }>;
}

export interface GlobalSettings {
  processConcurrency: number;
  tickBudgetSeconds: number;
  tickChainEnabled: boolean;
  batchClaimEnabled: boolean;
  adaptiveBackoff: boolean;
  perNumberDefaults: { meta: number; waha: number };
}

export interface HistoryEntry {
  id: string;
  createdAt: string;
  sessionId: string | null;
  numero: string | null;
  userName: string | null;
  summary: string | null;
  reason: string | null;
  changes: Record<string, { before: unknown; after: unknown }> | null;
}

export interface LimitsOverview {
  numbers: NumberLimits[];
  globals: GlobalSettings;
  history: HistoryEntry[];
  /** false = migration 192 ainda não aplicada: o botão de pausa fica desligado. */
  pauseSupported: boolean;
  /** Limite/s por qualidade (P1-5/migration 190), por número Meta: null se a 190 não está aplicada. */
  rate: Record<string, RateInfo> | null;
  /** Teto físico de limite/s por número (política da conta); null sem a 190. */
  rateCeiling: number | null;
  /** Mudanças de limite/s e de qualidade (histórico imutável da 190), mais recentes primeiro. */
  rateHistory: RateHistoryEntry[];
}

export interface RateInfo {
  quality: string | null;
  tier: string | null;
  autoPerSecond: number | null;
  autoTargetPerSecond: number | null;
  manualPerSecond: number | null;
  manualReason: string | null;
  forceAboveQuality: boolean;
  effectivePerSecond: number | null;
  /** "auto" | "manual" | … (effective_source da API do limite/s). */
  source: string | null;
  inCooldown: boolean;
  ramping: boolean;
  requiresOwnerConfirmation: boolean;
}

export interface RateHistoryEntry {
  id: string;
  createdAt: string;
  sessionId: string;
  numero: string | null;
  source: string;
  qualityOld: string | null;
  qualityNew: string | null;
  rateOld: number | null;
  rateNew: number | null;
  reason: string | null;
}

/**
 * Limite/s por número e política, direto do serviço do PR #140 (mesma regra de GET /api/disparador/rate-limits).
 * Sem a migration 190 (ou qualquer falha de leitura), devolve null: a tela mostra "indisponível" e segue.
 */
export async function loadRateInfo(db: LimitsDb, accountId: string): Promise<{ byNumber: Map<string, RateInfo>; ceiling: number } | null> {
  try {
    const view = await listRateLimits(db as unknown as Parameters<typeof listRateLimits>[0], accountId);
    const byNumber = new Map<string, RateInfo>();
    for (const c of view.channels) {
      byNumber.set(c.session_id, {
        quality: c.health?.quality_rating ?? null,
        tier: c.health?.messaging_limit_tier ?? null,
        autoPerSecond: c.rate?.auto_effective ?? null,
        autoTargetPerSecond: c.rate?.auto_target ?? null,
        manualPerSecond: c.rate?.manual ?? null,
        manualReason: c.rate?.manual_reason ?? null,
        forceAboveQuality: c.rate?.force_above_quality === true,
        effectivePerSecond: c.rate?.effective ?? null,
        source: c.rate?.effective_source ?? null,
        inCooldown: c.rate?.in_cooldown === true,
        ramping: c.rate?.ramping === true,
        requiresOwnerConfirmation: c.requires_owner_confirmation,
      });
    }
    return { byNumber, ceiling: view.ceiling };
  } catch {
    return null;
  }
}

export async function loadRateHistory(db: LimitsDb, accountId: string, labels: Map<string, string>): Promise<RateHistoryEntry[]> {
  const { data, error } = await run<
    Array<{
      id: string;
      created_at: string;
      session_id: string;
      source: string;
      quality_old: string | null;
      quality_new: string | null;
      rate_old: number | string | null;
      rate_new: number | string | null;
      reason: string | null;
    }>
  >(
    db
      .from("dispatch_channel_rate_history")
      .select("id, created_at, session_id, source, quality_old, quality_new, rate_old, rate_new, reason")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  );
  if (error) return [];
  const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));
  return (data ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    sessionId: r.session_id,
    numero: labels.get(r.session_id) ?? null,
    source: r.source,
    qualityOld: r.quality_old,
    qualityNew: r.quality_new,
    rateOld: num(r.rate_old),
    rateNew: num(r.rate_new),
    reason: r.reason,
  }));
}

export function readGlobals(env: Record<string, string | undefined> = process.env): GlobalSettings {
  const cfg = resolveThroughputConfig(env);
  return {
    processConcurrency: cfg.globalConcurrency,
    tickBudgetSeconds: Math.round(cfg.tickBudgetMs / 1000),
    tickChainEnabled: isTickChainEnabled(env),
    batchClaimEnabled: isBatchClaimEnabled(env),
    adaptiveBackoff: cfg.adaptiveBackoff,
    perNumberDefaults: { meta: cfg.perNumber.meta, waha: cfg.perNumber.waha },
  };
}

/** Canal com nome/telefone resolvidos como na tela Canais (channel-label.ts). */
interface RawConfig {
  id: string;
  phone_number: string | null;
  display_name: string;
  provider: string | null;
  habilitado: boolean | null;
  connected: boolean | null;
  connectionError: string | null;
}
interface RawLimit {
  session_id: string;
  max_in_flight: number | null;
  hourly_limit: number | null;
  paused?: boolean | null;
}

const toRawConfig = (i: ChannelIdentity): RawConfig => ({
  id: i.id,
  phone_number: i.phone,
  display_name: i.name,
  provider: i.provider,
  habilitado: i.enabled,
  connected: i.connected,
  connectionError: i.connectionError,
});

async function loadConfigs(db: LimitsDb, accountId: string): Promise<RawConfig[]> {
  // Números/Controles são superfícies operacionais: configurações antigas
  // desabilitadas continuam visíveis em /canais, mas não participam do
  // motor nem recebem limites/vagas no Disparador.
  return (await loadChannelIdentities(db, accountId))
    .filter((identity) => identity.enabled)
    .map(toRawConfig);
}

const providerOf = (p: string | null): DispatchProvider | "unknown" => (p === "meta" || p === "waha" ? p : "unknown");

async function loadLimitRows(db: LimitsDb, ids: string[]): Promise<{ rows: Map<string, RawLimit>; pauseSupported: boolean }> {
  const rows = new Map<string, RawLimit>();
  if (ids.length === 0) return { rows, pauseSupported: true };
  let pauseSupported = true;
  let res = await run<RawLimit[]>(db.from("dispatch_channel_limits").select("session_id, max_in_flight, hourly_limit, paused").in("session_id", ids));
  if (res.error && isMissingColumn(res.error)) {
    pauseSupported = false;
    res = await run<RawLimit[]>(db.from("dispatch_channel_limits").select("session_id, max_in_flight, hourly_limit").in("session_id", ids));
  }
  if (res.error) throw new Error(`Falha ao ler limites: ${res.error.message}`);
  for (const r of res.data ?? []) rows.set(r.session_id, r);
  return { rows, pauseSupported };
}

export function labelOf(c: Pick<RawConfig, "display_name">): string {
  return c.display_name;
}

export async function loadLimitsOverview(
  db: LimitsDb,
  accountId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LimitsOverview> {
  const globals = readGlobals(env);
  const configs = await loadConfigs(db, accountId);
  const { rows, pauseSupported } = await loadLimitRows(db, configs.map((c) => c.id));

  // Campanhas em execução da conta, por número (session_ids).
  const camps = await run<Array<{ id: string; nome: string; session_ids: string[] | null }>>(
    db.from("campaigns").select("id, nome, session_ids").eq("account_id", accountId).eq("status", "em_execucao").limit(500),
  );
  if (camps.error) throw new Error(`Falha ao ler campanhas: ${camps.error.message}`);
  const bySession = new Map<string, Array<{ id: string; nome: string }>>();
  for (const c of camps.data ?? []) {
    for (const s of c.session_ids ?? []) {
      const list = bySession.get(s) ?? [];
      list.push({ id: c.id, nome: c.nome });
      bySession.set(s, list);
    }
  }

  const numbers: NumberLimits[] = configs.map((c) => {
    const provider = providerOf(c.provider);
    const row = rows.get(c.id);
    const def = provider === "meta" ? globals.perNumberDefaults.meta : provider === "waha" ? globals.perNumberDefaults.waha : Math.min(globals.perNumberDefaults.waha, 4);
    const maxAllowed = maxInFlightCeiling(provider);
    return {
      id: c.id,
      label: labelOf(c),
      phone: c.phone_number,
      connected: c.connected,
      connectionError: c.connectionError,
      provider,
      enabled: c.habilitado !== false,
      maxInFlight: row?.max_in_flight ?? null,
      effectiveMaxInFlight: row?.max_in_flight ?? def,
      defaultMaxInFlight: def,
      maxAllowed,
      hourlyLimit: row?.hourly_limit ?? null,
      paused: row?.paused === true,
      hasRow: !!row,
      activeCampaigns: bySession.get(c.id) ?? [],
    };
  });
  // Habilitados primeiro, depois por nome.
  numbers.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label, "pt-BR"));

  const history = await loadHistory(db, accountId, new Map(configs.map((c) => [c.id, labelOf(c)])));
  const labels = new Map(configs.map((c) => [c.id, labelOf(c)]));
  const [rate, rateHistory] = await Promise.all([loadRateInfo(db, accountId), loadRateHistory(db, accountId, labels)]);
  return {
    numbers,
    globals,
    history,
    pauseSupported,
    rate: rate ? Object.fromEntries(rate.byNumber) : null,
    rateCeiling: rate?.ceiling ?? null,
    rateHistory: rate ? rateHistory : [],
  };
}

export async function loadHistory(db: LimitsDb, accountId: string, labels: Map<string, string>): Promise<HistoryEntry[]> {
  const { data, error } = await run<
    Array<{
      id: string;
      created_at: string;
      resource_id: string | null;
      user_name: string | null;
      summary: string | null;
      changes: HistoryEntry["changes"];
      metadata: { reason?: string } | null;
    }>
  >(
    db
      .from("audit_logs")
      .select("id, created_at, resource_id, user_name, summary, changes, metadata")
      .eq("account_id", accountId)
      .eq("resource_type", AUDIT_RESOURCE)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  );
  // Histórico é complemento: se a leitura falhar, a tela continua.
  if (error) return [];
  return (data ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    sessionId: r.resource_id,
    numero: r.resource_id ? (labels.get(r.resource_id) ?? null) : null,
    userName: r.user_name,
    summary: r.summary,
    reason: r.metadata?.reason ?? null,
    changes: r.changes ?? null,
  }));
}

export interface ApplyResult {
  changes: Change[];
  after: LimitsValues;
  label: string;
  noop: boolean;
}

/**
 * Valida (conta, faixa, estado esperado) e grava. Não escreve se nada mudou. A auditoria é do chamador (route),
 * que tem o contexto da sessão, e só roda depois da escrita bem-sucedida.
 */
export async function applyLimitsChange(
  db: LimitsDb,
  accountId: string,
  req: LimitsRequest,
  env: Record<string, string | undefined> = process.env,
): Promise<ApplyResult> {
  const identity = (await loadChannelIdentities(db, accountId, { sessionId: req.sessionId }))[0];
  // Número de outra conta, inexistente ou desabilitado não pode receber
  // alteração operacional pelo endpoint, mesmo por chamada direta.
  if (!identity || !identity.enabled) {
    throw new LimitsInputError("Número não encontrado ou desabilitado.", 404);
  }
  const cfg = toRawConfig(identity);

  const provider = providerOf(cfg.provider);
  validatePatchForProvider(req.patch, provider);

  const { rows, pauseSupported } = await loadLimitRows(db, [cfg.id]);
  if (req.patch.paused !== undefined && !pauseSupported) {
    throw new LimitsInputError("A pausa por número exige a migration 192 (ainda não aplicada neste banco).", 409);
  }
  const row = rows.get(cfg.id);
  const globals = readGlobals(env);
  const defaultMax = provider === "meta" ? globals.perNumberDefaults.meta : Math.min(globals.perNumberDefaults.waha, 4);
  const current: LimitsValues = {
    maxInFlight: row?.max_in_flight ?? null,
    hourlyLimit: row?.hourly_limit ?? null,
    paused: row?.paused === true,
  };

  // A tela mostrou um "antes"; se o banco mudou desde então, recusa (ninguém sobrescreve a mudança do outro).
  if (req.expected) {
    for (const k of ["maxInFlight", "hourlyLimit", "paused"] as const) {
      if (k in req.expected && req.expected[k] !== current[k]) {
        throw new LimitsInputError("Os valores mudaram desde que você abriu a tela. Recarregue e confira o novo \"antes\".", 409);
      }
    }
  }

  const changes = diffLimits(current, req.patch);
  const label = labelOf(cfg);
  const after: LimitsValues = {
    maxInFlight: req.patch.maxInFlight ?? current.maxInFlight,
    hourlyLimit: req.patch.hourlyLimit !== undefined ? req.patch.hourlyLimit : current.hourlyLimit,
    paused: req.patch.paused ?? current.paused,
  };
  if (changes.length === 0) return { changes, after, label, noop: true };

  const values: Record<string, unknown> = {};
  for (const c of changes) values[c.field] = c.after;

  if (row) {
    const { error } = await run(db.from("dispatch_channel_limits").update(values).eq("session_id", cfg.id));
    if (error) throw new Error(`Falha ao gravar o limite: ${error.message}`);
  } else {
    // Sem linha: nasce com as vagas que já valem (padrão do provedor), para não mudar o que o resto faz.
    const insert: Record<string, unknown> = { session_id: cfg.id, max_in_flight: Math.min(defaultMax, maxInFlightCeiling(provider)), ...values };
    const { error } = await run(db.from("dispatch_channel_limits").insert(insert));
    if (error) throw new Error(`Falha ao gravar o limite: ${error.message}`);
  }
  return { changes, after, label, noop: false };
}

