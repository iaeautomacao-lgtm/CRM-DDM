// Heartbeat do item em voo (PRD 11, F14 / migration 194).
//
// O claim grava disp_message_queue.inflight_until = agora + 120 s ao marcar o item 'enviando'. Enquanto espera a
// resposta do provedor, quem envia RENOVA o lease a cada 30 s (só se a espera passar disso — o envio normal dura ~1 s e
// não escreve nada). O watchdog (reconcile-unknown-provider-outcomes.ts) só age em item com lease VENCIDO: um envio
// lento mas vivo nunca vira "incerto" por engano; um processo que morreu deixa de renovar e o item é tratado como hoje.
//
// O timer vive só durante o envio (é parado no finally) — não é worker em memória, compatível com o Passenger.
// Sem a coluna (migration 194 ausente: 42703/PGRST204) a renovação se desliga sozinha e tudo segue como antes.

import type { SupabaseClient } from "@supabase/supabase-js";

export const INFLIGHT_LEASE_SECONDS = 120;
export const INFLIGHT_RENEW_EVERY_MS = 30_000;

let columnMissing = false;

/** Só para testes. */
export function resetInflightLeaseState(): void {
  columnMissing = false;
}

export function isMissingInflightColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /inflight_until/i.test(error.message ?? ""));
}

export interface InflightLease {
  stop(): void;
}

/**
 * Renova o lease do item enquanto o envio durar. Chame `stop()` no finally. Nunca lança: falha ao renovar só significa
 * que o lease vai vencer (comportamento anterior à migration).
 */
export function startInflightLease(
  db: SupabaseClient,
  itemId: string,
  options: { everyMs?: number; leaseSeconds?: number; now?: () => number } = {},
): InflightLease {
  if (columnMissing) return { stop() {} };
  const everyMs = options.everyMs ?? INFLIGHT_RENEW_EVERY_MS;
  const leaseMs = (options.leaseSeconds ?? INFLIGHT_LEASE_SECONDS) * 1000;
  const now = options.now ?? Date.now;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || columnMissing) return;
    void (async () => {
      try {
        const { error } = await db
          .from("disp_message_queue")
          .update({ inflight_until: new Date(now() + leaseMs).toISOString() })
          .eq("id", itemId)
          .eq("status", "enviando");
        if (error && isMissingInflightColumn(error)) columnMissing = true;
        else if (error) console.error("[Disparador] Falha ao renovar o lease do item em voo:", error.message);
      } catch (err) {
        console.error("[Disparador] Falha ao renovar o lease do item em voo:", err instanceof Error ? err.message : err);
      }
    })();
  }, everyMs);
  // Não segura o processo vivo só por causa do lease.
  (timer as { unref?: () => void }).unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
