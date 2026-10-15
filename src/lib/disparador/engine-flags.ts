// Chaves do motor do Disparador pela TELA (decisão do dono, 15/10): claim em lote (DISPARADOR_BATCH_CLAIM), tick encadeado
// (DISPARADOR_TICK_CHAIN) e worker de envio (DISPATCH_WORKER_ENABLED), por conta no banco (wacrm.dispatch_engine_flags, migrations 366 e 367),
// com fallback para o ambiente.
//
// Regra: NULL na conta = segue o ambiente; true/false = decisão da conta. O motor é compartilhado entre as contas, então, havendo várias linhas:
// "ligar" de qualquer uma liga; senão "desligar" de qualquer uma desliga; senão vale o ambiente. Sem a tabela (migration não aplicada) ou com
// falha de leitura, vale só o ambiente — o motor nunca para por causa disto. A leitura é cacheada por 10 s por processo.
// Padrão de TODAS: desligado (o cron de hoje). A chave do worker só tem efeito se houver worker com lease vivo (worker-ownership.ts).
import type { SupabaseClient } from "@supabase/supabase-js";
import { isBatchClaimEnabled } from "@/lib/disparador/batch-claim";
import { isTickChainEnabled } from "@/lib/disparador/tick-chain";

type Env = Record<string, string | undefined>;
type Db = Pick<SupabaseClient, "from">;

/** Nome da chave = nome da coluna em dispatch_engine_flags = campo do corpo do PUT /api/disparador/engine. */
export type EngineFlagName = "batch_claim" | "tick_chain" | "worker_enabled";
export const ENGINE_FLAGS: readonly EngineFlagName[] = ["batch_claim", "tick_chain", "worker_enabled"];
/** Colunas da migration 366 (as que existem mesmo sem a 367). */
const BASE_FLAGS: readonly EngineFlagName[] = ["batch_claim", "tick_chain"];

export const ENGINE_FLAG_ENV: Record<EngineFlagName, string> = {
  batch_claim: "DISPARADOR_BATCH_CLAIM",
  tick_chain: "DISPARADOR_TICK_CHAIN",
  worker_enabled: "DISPATCH_WORKER_ENABLED",
};

export interface EngineFlagRow {
  account_id: string;
  batch_claim: boolean | null;
  tick_chain: boolean | null;
  /** Migration 367; ausente = segue o ambiente. */
  worker_enabled?: boolean | null;
}

export type EngineFlagSource = "account" | "env" | "default";

export interface ResolvedEngineFlag {
  enabled: boolean;
  /** account = decisão de uma conta; env = variável de ambiente; default = nada definido (desligado). */
  source: EngineFlagSource;
}

export function isWorkerEnabled(env: Env = process.env): boolean {
  const raw = (env.DISPATCH_WORKER_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

const envEnabled = (name: EngineFlagName, env: Env) =>
  name === "batch_claim" ? isBatchClaimEnabled(env) : name === "tick_chain" ? isTickChainEnabled(env) : isWorkerEnabled(env);
const envDefined = (name: EngineFlagName, env: Env) => (env[ENGINE_FLAG_ENV[name]] ?? "").trim() !== "";

/** Valor efetivo de uma chave: contas (ligar vence desligar) → ambiente → desligado. */
export function resolveEngineFlag(name: EngineFlagName, rows: readonly EngineFlagRow[], env: Env = process.env): ResolvedEngineFlag {
  const values = rows.map((r) => r[name]).filter((v): v is boolean => v === true || v === false);
  if (values.includes(true)) return { enabled: true, source: "account" };
  if (values.includes(false)) return { enabled: false, source: "account" };
  return { enabled: envEnabled(name, env), source: envDefined(name, env) ? "env" : "default" };
}

/** Cópia do ambiente com as chaves decididas por conta já gravadas ('1'/'0'): os resolvedores existentes seguem aceitando `env`. */
export function envWithEngineFlags(env: Env, rows: readonly EngineFlagRow[]): Env {
  const out: Env = { ...env };
  for (const name of ENGINE_FLAGS) {
    const flag = resolveEngineFlag(name, rows, env);
    if (flag.source === "account") out[ENGINE_FLAG_ENV[name]] = flag.enabled ? "1" : "0";
  }
  return out;
}

const CACHE_TTL_MS = 10_000;
let cache: { at: number; rows: EngineFlagRow[] } | null = null;

export function clearEngineFlagCache(): void {
  cache = null;
}

const isMissingTable = (e: { code?: string; message: string }) => e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist|schema cache/i.test(e.message);
const isMissingColumn = (e: { code?: string; message: string }) => e.code === "42703" || /column .* does not exist/i.test(e.message);

/** Linhas de dispatch_engine_flags (poucas: 1 por conta). Nunca lança: sem tabela ou com erro devolve [] (vale o ambiente). */
export async function loadEngineFlagRows(db: Db, options: { now?: number; ttlMs?: number } = {}): Promise<EngineFlagRow[]> {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? CACHE_TTL_MS;
  if (cache && now - cache.at < ttl) return cache.rows;
  try {
    const read = (columns: readonly EngineFlagName[]) => db.from("dispatch_engine_flags").select(`account_id, ${columns.join(", ")}`).limit(500);
    let res = await read(ENGINE_FLAGS);
    // Só a 366 aplicada (sem worker_enabled): lê as duas chaves de sempre.
    if (res.error && isMissingColumn(res.error)) res = await read(BASE_FLAGS);
    const { data, error } = res;
    if (error) {
      // 42P01 = migration 366 ainda não aplicada: normal, segue o ambiente (sem poluir o log a cada tick).
      if (!isMissingTable(error)) console.error("[engine-flags] falha ao ler as chaves do motor; usando o ambiente:", error.message);
      cache = { at: now, rows: [] };
      return [];
    }
    const rows = (data ?? []) as unknown as EngineFlagRow[];
    cache = { at: now, rows };
    return rows;
  } catch (error) {
    console.error("[engine-flags] falha ao ler as chaves do motor; usando o ambiente:", error instanceof Error ? error.message : error);
    return [];
  }
}

export interface EngineFlagsView {
  /** Valor desta conta (null = segue o ambiente). */
  account: Record<EngineFlagName, boolean | null>;
  /** Valor que o motor usa agora (todas as contas + ambiente). */
  effective: Record<EngineFlagName, ResolvedEngineFlag>;
  /** Valor do ambiente sozinho (o que valeria sem decisão de conta). */
  env: Record<EngineFlagName, boolean>;
}

export function buildEngineFlagsView(accountId: string, rows: readonly EngineFlagRow[], env: Env = process.env): EngineFlagsView {
  const mine = rows.find((r) => r.account_id === accountId);
  const account = {} as EngineFlagsView["account"];
  const effective = {} as EngineFlagsView["effective"];
  const envOnly = {} as EngineFlagsView["env"];
  for (const name of ENGINE_FLAGS) {
    account[name] = mine?.[name] ?? null;
    effective[name] = resolveEngineFlag(name, rows, env);
    envOnly[name] = envEnabled(name, env);
  }
  return { account, effective, env: envOnly };
}

export class EngineFlagsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "EngineFlagsError";
  }
}

/** Corpo do PUT: { batch_claim?, tick_chain?, worker_enabled? } com boolean ou null (volta a seguir o ambiente); pelo menos uma chave. */
export function parseEngineFlagsPatch(body: unknown): Partial<Record<EngineFlagName, boolean | null>> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new EngineFlagsError("Corpo inválido.", 400);
  const input = body as Record<string, unknown>;
  const patch: Partial<Record<EngineFlagName, boolean | null>> = {};
  for (const name of ENGINE_FLAGS) {
    if (!(name in input)) continue;
    const value = input[name];
    if (value !== null && typeof value !== "boolean") throw new EngineFlagsError(`'${name}' deve ser true, false ou null.`, 400);
    patch[name] = value;
  }
  if (Object.keys(patch).length === 0) throw new EngineFlagsError("Informe 'batch_claim', 'tick_chain' e/ou 'worker_enabled'.", 400);
  return patch;
}

/** Grava as chaves da conta (upsert) e invalida o cache do processo. Quem chama já checou permissão. */
export async function saveEngineFlags(
  db: Db,
  input: { accountId: string; userId: string | null; patch: Partial<Record<EngineFlagName, boolean | null>> },
): Promise<EngineFlagRow> {
  const wantsWorker = input.patch.worker_enabled !== undefined;
  const read = (columns: readonly EngineFlagName[]) => db.from("dispatch_engine_flags").select(`account_id, ${columns.join(", ")}`).eq("account_id", input.accountId).limit(1);
  let hasWorkerColumn = true;
  let res = await read(ENGINE_FLAGS);
  if (res.error && isMissingColumn(res.error)) {
    hasWorkerColumn = false;
    res = await read(BASE_FLAGS);
  }
  if (res.error) {
    if (isMissingTable(res.error)) throw new EngineFlagsError("As chaves do motor exigem a migration 366 (ainda não aplicada neste banco).", 503);
    throw new EngineFlagsError("Não foi possível ler as chaves do motor.", 500);
  }
  if (wantsWorker && !hasWorkerColumn) throw new EngineFlagsError("A chave do worker exige a migration 367 (ainda não aplicada neste banco).", 503);
  const current = ((res.data ?? [])[0] as unknown as EngineFlagRow | undefined) ?? { account_id: input.accountId, batch_claim: null, tick_chain: null, worker_enabled: null };
  const next: EngineFlagRow = {
    account_id: input.accountId,
    batch_claim: input.patch.batch_claim !== undefined ? input.patch.batch_claim : current.batch_claim,
    tick_chain: input.patch.tick_chain !== undefined ? input.patch.tick_chain : current.tick_chain,
    ...(hasWorkerColumn ? { worker_enabled: input.patch.worker_enabled !== undefined ? input.patch.worker_enabled : (current.worker_enabled ?? null) } : {}),
  };
  const { error } = await db
    .from("dispatch_engine_flags")
    .upsert({ ...next, updated_by: input.userId, updated_at: new Date().toISOString() }, { onConflict: "account_id" });
  if (error) throw new EngineFlagsError("Não foi possível gravar as chaves do motor.", 500);
  clearEngineFlagCache();
  return next;
}
