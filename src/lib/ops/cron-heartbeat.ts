import "server-only";
// Batimento dos crons (AUDIT-DISPARADOR D-12, migration 334): cada rota de cron registra, ao terminar, quando rodou e como terminou.
// O cartão "Saúde do sistema" (system-health.ts) lê a tabela e mostra os crons que pararam. Tudo best-effort: sem a migration, ou se o
// registro falhar, o cron responde exatamente como antes (nunca lança, nunca atrasa mais que o teto abaixo).

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { CRON_JOBS, type CronJob } from "./cron-jobs";

export { CRON_JOBS, type CronJob };

type Db = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string; code?: string } | null }> };

/** Teto de espera do registro: o batimento nunca segura a resposta do cron além disto. */
export const HEARTBEAT_TIMEOUT_MS = 1_500;

/**
 * Como a resposta conta para o batimento: 401 (segredo errado, ex.: sonda) NÃO é execução do cron; 2xx/202 = ok; o resto = erro
 * (inclusive 503 "cron not configured", que é configuração quebrada e precisa aparecer).
 */
export function heartbeatStatusFor(httpStatus: number): "ok" | "error" | null {
  if (httpStatus === 401) return null;
  return httpStatus >= 200 && httpStatus < 300 ? "ok" : "error";
}

export async function recordCronHeartbeat(
  job: CronJob,
  result: { status: "ok" | "error"; durationMs: number; error?: string | null },
  db?: Db,
  timeoutMs: number = HEARTBEAT_TIMEOUT_MS,
): Promise<void> {
  try {
    // O cliente é criado DENTRO do try: sem variáveis do Supabase (testes, ambiente quebrado) o batimento some em silêncio.
    const client = db ?? (supabaseAdmin() as unknown as Db);
    const write = Promise.resolve(
      client.rpc("cron_heartbeat_record", {
        p_job: job,
        p_expected_every_seconds: CRON_JOBS[job].every,
        p_status: result.status,
        p_duration_ms: Math.max(0, Math.round(result.durationMs)),
        p_error: result.error ?? null,
      }),
    ).then(({ error }) => {
      // Migration 334 ausente (PGRST202/42883): silêncio; outro erro só vai para o log.
      if (error && error.code !== "PGRST202" && error.code !== "42883") console.error("[cron-heartbeat] falha ao registrar:", error.message);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([write, new Promise<void>((resolve) => ((timer = setTimeout(resolve, timeoutMs)), timer.unref?.()))]);
    if (timer) clearTimeout(timer);
  } catch (error) {
    console.error("[cron-heartbeat] falha ao registrar:", error instanceof Error ? error.message : error);
  }
}

/**
 * Envolve o handler POST de um cron: registra o batimento DEPOIS da resposta pronta. Exceção do handler vira batimento de erro e é
 * relançada igual. Não altera a resposta nem o status.
 */
export async function trackCron(job: CronJob, run: () => Promise<Response>, db?: Db): Promise<Response> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await run();
  } catch (error) {
    await recordCronHeartbeat(job, { status: "error", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }, db);
    throw error;
  }
  const status = heartbeatStatusFor(response.status);
  if (status) {
    await recordCronHeartbeat(job, { status, durationMs: Date.now() - startedAt, error: status === "error" ? `HTTP ${response.status}` : null }, db);
  }
  return response;
}
