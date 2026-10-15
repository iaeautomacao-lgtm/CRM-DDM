// Convivência entre o cron e o worker de envio (W1): quem envia cada número.
//
// Regra: o cron só PULA um número quando (1) a chave do worker está ligada (engine-flags.ts, padrão DESLIGADA) E (2) o número tem dono VIVO
// (lease não expirado e wacrm.dispatch_channel_ownership.mode = 'worker'). Sem worker vivo, com a chave desligada, sem as tabelas da migration
// 367 ou com erro de leitura, o cron envia todos os números exatamente como hoje (failover: lease expirado ⇒ o cron assume).
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = Pick<SupabaseClient, "rpc">;

export const LEASE_TTL_SECONDS = 30;
export const LEASE_RENEW_EVERY_MS = 10_000;

/** Números com worker vivo (vazio se a 367 não existe ou se a leitura falhar: o cron cobre). Nunca lança. */
export async function loadLiveWorkerSessions(db: Db): Promise<Set<string>> {
  try {
    const { data, error } = await db.rpc("live_worker_sessions");
    if (error) {
      // 42883/PGRST202 = migration 367 ausente: normal, o cron envia tudo.
      if (error.code !== "42883" && error.code !== "PGRST202") console.error("[worker-ownership] falha ao ler os donos vivos; o cron cobre:", error.message);
      return new Set();
    }
    return new Set(Array.isArray(data) ? (data as string[]) : []);
  } catch (error) {
    console.error("[worker-ownership] falha ao ler os donos vivos; o cron cobre:", error instanceof Error ? error.message : error);
    return new Set();
  }
}
