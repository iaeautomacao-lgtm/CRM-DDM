import "server-only";
// PRD 24, item 5 — "Saúde do sistema" (cartão em Logs): só dados que já existem, sem inventar número.
//
//   migrations   wacrm.schema_check_report() (migration 202) comparado com scripts/required-migrations.json
//   crons        idade do último `cron_tick` do disparador em system_logs (única telemetria de cron que o sistema grava hoje;
//                a tabela `cron_status` do PRD 15 ainda não existe — quando existir, entra aqui como outra entrada)
//   inbox        wacrm.message_inbox_stats() (migration 201): profundidade, mais antiga pendente, dead
// Cada bloco degrada sozinho: migration ausente / erro de leitura ⇒ `available: false` com motivo curto; um bloco quebrado nunca
// derruba os outros. Nada de dado de cliente: só contagens, versões e idades. Limiares abaixo são técnicos (o tick roda a cada ~1 min).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — módulo .mjs de scripts/ (mesma lógica do `npm run schema:check`)
import { compareWithReport } from "../../../scripts/lib/migrations-registry.mjs";
import { CRON_JOBS, type CronJob } from "./cron-jobs";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export interface RequiredMigrations {
  minVersion: number;
  migrations: Array<{ version: string; kind: "registry" | "index"; index?: string }>;
}

export type Level = "ok" | "atrasado" | "parado" | "indisponivel";

export interface SystemHealth {
  generated_at: string;
  migrations:
    | { available: true; total: number; applied: number; missing: string[]; invalid_indexes: string[]; ok: boolean }
    | { available: false; reason: string };
  crons: Array<{
    job: string;
    last_ok_at: string | null;
    age_s: number | null;
    status: Level;
    /** Migration 334 (batimento de todos os crons); ausentes no registro antigo só do cron_tick. */
    label?: string;
    expected_every_s?: number;
    last_status?: "ok" | "error";
    last_error?: string | null;
    runs?: number;
    failures?: number;
  }>;
  inbox:
    | { available: true; pending: number; oldest_pending_s: number | null; dead: number; shadow_missing: number; ok: boolean }
    | { available: false; reason: string };
  ok: boolean;
}

/** Tick de ~1 min: até 3 min é normal, até 10 min é atraso, depois disso está parado. */
export const CRON_LATE_AFTER_S = 3 * 60;
export const CRON_STOPPED_AFTER_S = 10 * 60;
/** Fila de mensagens recebidas: pendente há mais que isto já é problema (a Meta reenvia, mas o atendente não vê). */
export const INBOX_OLDEST_PENDING_WARN_S = 60;

export function loadRequiredMigrations(cwd: string = process.cwd()): RequiredMigrations | null {
  try {
    return JSON.parse(readFileSync(join(cwd, "scripts", "required-migrations.json"), "utf8")) as RequiredMigrations;
  } catch {
    return null;
  }
}

const isMissingFunction = (error: { code?: string; message?: string }) =>
  error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message ?? "");

export function cronLevel(ageSeconds: number | null): Level {
  if (ageSeconds === null) return "parado";
  if (ageSeconds > CRON_STOPPED_AFTER_S) return "parado";
  if (ageSeconds > CRON_LATE_AFTER_S) return "atrasado";
  return "ok";
}

/**
 * Nível de um cron pela sua cadência esperada: atrasado depois de 2,5 ciclos, parado depois de 6 (com os mesmos pisos de 3 e 10 min do
 * tick, então um job de 1 min continua com os limiares de sempre; o de renovação diária só alarma depois de ~15 h/36 h).
 */
export function cronLevelFor(ageSeconds: number | null, everySeconds: number): Level {
  if (ageSeconds === null) return "parado";
  if (ageSeconds > Math.max(CRON_STOPPED_AFTER_S, everySeconds * 6)) return "parado";
  if (ageSeconds > Math.max(CRON_LATE_AFTER_S, everySeconds * 2.5)) return "atrasado";
  return "ok";
}

async function migrationsBlock(db: Db, required: RequiredMigrations | null): Promise<SystemHealth["migrations"]> {
  if (!required) return { available: false, reason: "required-migrations.json ausente no servidor" };
  const { data, error } = await db.rpc("schema_check_report");
  if (error) return { available: false, reason: isMissingFunction(error) ? "migration 202 não aplicada" : "falha ao ler o registro de migrations" };
  const rows = compareWithReport(required, data) as Array<{ version: string; kind: string; index?: string; status: string }>;
  const missing = rows.filter((r) => r.status === "faltando").map((r) => r.version);
  const invalid = rows.filter((r) => r.status === "índice inválido").map((r) => r.version);
  const applied = rows.filter((r) => r.status === "aplicada").length;
  return { available: true, total: rows.length, applied, missing, invalid_indexes: invalid, ok: missing.length === 0 && invalid.length === 0 };
}

type HeartbeatRow = {
  job: string;
  expected_every_seconds: number;
  last_ok_at: string | null;
  last_status: "ok" | "error";
  last_error: string | null;
  runs: number | string;
  failures: number | string;
};

/** Batimento de todos os crons (migration 334). null = tabela ausente/ilegível (cai no registro antigo, só do cron_tick). */
async function heartbeatCrons(db: Db, now: Date): Promise<SystemHealth["crons"] | null> {
  const { data, error } = await db
    .from("cron_heartbeat")
    .select("job, expected_every_seconds, last_ok_at, last_status, last_error, runs, failures")
    .order("job", { ascending: true })
    .limit(100);
  if (error || !Array.isArray(data)) return null;
  const rows = new Map((data as HeartbeatRow[]).map((r) => [r.job, r]));
  const out: SystemHealth["crons"] = [];
  for (const [job, def] of Object.entries(CRON_JOBS) as Array<[CronJob, (typeof CRON_JOBS)[CronJob]]>) {
    const r = rows.get(job);
    // Job que nunca registrou batimento: pode simplesmente não estar agendado nesta instalação. Não é alarme: fica "indisponivel".
    if (!r) {
      out.push({ job, label: def.label, last_ok_at: null, age_s: null, status: "indisponivel", expected_every_s: def.every });
      continue;
    }
    const age = r.last_ok_at ? Math.max(0, Math.round((now.getTime() - new Date(r.last_ok_at).getTime()) / 1000)) : null;
    out.push({
      job,
      label: def.label,
      last_ok_at: r.last_ok_at,
      age_s: age,
      // O nível vem da idade do ÚLTIMO OK: um cron que só falha (503, exceção) envelhece até "atrasado"/"parado" mesmo "rodando".
      status: cronLevelFor(age, r.expected_every_seconds),
      expected_every_s: r.expected_every_seconds,
      last_status: r.last_status,
      last_error: r.last_error,
      runs: Number(r.runs),
      failures: Number(r.failures),
    });
  }
  return out;
}

async function cronsBlock(db: Db, now: Date): Promise<SystemHealth["crons"]> {
  const heartbeat = await heartbeatCrons(db, now).catch(() => null);
  if (heartbeat) return heartbeat;
  const { data, error } = await db
    .from("system_logs")
    .select("created_at")
    .eq("source", "disparador")
    .eq("event", "cron_tick")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return [{ job: "disparador", last_ok_at: null, age_s: null, status: "indisponivel" }];
  const last = (data as Array<{ created_at: string }> | null)?.[0]?.created_at ?? null;
  const age = last ? Math.max(0, Math.round((now.getTime() - new Date(last).getTime()) / 1000)) : null;
  return [{ job: "disparador", last_ok_at: last, age_s: age, status: cronLevel(age) }];
}

async function inboxBlock(db: Db): Promise<SystemHealth["inbox"]> {
  const { data, error } = await db.rpc("message_inbox_stats");
  if (error) return { available: false, reason: isMissingFunction(error) ? "migration 201 não aplicada" : "falha ao ler a fila de mensagens" };
  const s = (data ?? {}) as { by_state?: Record<string, number>; oldest_pending_seconds?: number | null; dead?: number; shadow_missing?: number };
  const pending = Number(s.by_state?.pending ?? 0) + Number(s.by_state?.processing ?? 0);
  const oldest = s.oldest_pending_seconds ?? null;
  const dead = Number(s.dead ?? 0);
  return {
    available: true,
    pending,
    oldest_pending_s: oldest,
    dead,
    shadow_missing: Number(s.shadow_missing ?? 0),
    ok: dead === 0 && (oldest === null || oldest <= INBOX_OLDEST_PENDING_WARN_S),
  };
}

export async function buildSystemHealth(db: Db, options: { now?: Date; required?: RequiredMigrations | null } = {}): Promise<SystemHealth> {
  const now = options.now ?? new Date();
  const required = options.required === undefined ? loadRequiredMigrations() : options.required;
  const [migrations, crons, inbox] = await Promise.all([
    migrationsBlock(db, required).catch((): SystemHealth["migrations"] => ({ available: false, reason: "erro inesperado" })),
    cronsBlock(db, now).catch((): SystemHealth["crons"] => [{ job: "disparador", last_ok_at: null, age_s: null, status: "indisponivel" }]),
    inboxBlock(db).catch((): SystemHealth["inbox"] => ({ available: false, reason: "erro inesperado" })),
  ]);
  const ok =
    (!migrations.available || migrations.ok) && crons.every((c) => c.status === "ok" || c.status === "indisponivel") && (!inbox.available || inbox.ok);
  return { generated_at: now.toISOString(), migrations, crons, inbox, ok };
}
