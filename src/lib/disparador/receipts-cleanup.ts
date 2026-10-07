import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Manutenção stateless, só com pelo menos 10s livres no orçamento. */
export async function cleanupOrphanReceipts(
  db: SupabaseClient,
  stopAt: number,
  lostLease: () => boolean,
  now: () => number = Date.now
): Promise<void> {
  if (lostLease() || now() >= stopAt - 10_000) return;
  try {
    // Não liberamos este lease: o TTL é a cadência de 10 minutos, inclusive
    // entre processos/restarts. Não depende do tick cair no minuto :00/:10.
    const { data: acquired, error: lockError } = await db.rpc("try_acquire_cron_lock", {
      p_name: "dispatch_receipts_cleanup",
      p_owner_id: randomUUID(),
      p_ttl_seconds: 600,
    });
    if (lockError) throw lockError;
    if (!acquired || lostLease() || now() >= stopAt - 10_000) return;
    const { error } = await db.rpc("cleanup_orphan_dispatch_receipts", { p_limit: 5000 });
    if (error) throw error;
  } catch (error) {
    // Migration ausente ou erro de manutenção não derrubam o disparador.
    console.error("[Cron] Falha ao limpar recibos órfãos:", error);
  }
}
