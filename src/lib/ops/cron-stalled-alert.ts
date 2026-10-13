import "server-only";
// Alerta ativo "cron parado" (item 5, 13/10): lê o batimento dos crons (migration 334) e, para cada cron em nível "parado", avisa
// (webhook dispatch.cron_stalled + push para admin/proprietário) as contas — 1 aviso por cron por conta por hora (claim_alert_slot).
// Roda dentro do cron de saúde dos números (a cada ~10 min), que é independente do tick de envio: se o tick parar, este ainda avisa.
// Nunca lança. O cron de saúde não se avisa a si mesmo (se ele próprio parar, quem o agenda precisa notar: ver docs/crons.md).

import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActiveAlert } from "@/lib/disparador/active-alerts";
import { heartbeatCrons } from "./system-health";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export const STALLED_ALERT_MAX_ACCOUNTS = 200;

export async function alertStalledCrons(db: Db, now: Date = new Date()): Promise<{ stalled: string[]; alerts: number }> {
  const out = { stalled: [] as string[], alerts: 0 };
  try {
    const crons = await heartbeatCrons(db, now);
    const stalled = (crons ?? []).filter((c) => c.status === "parado" && c.job !== "disparador_health");
    if (stalled.length === 0) return out;
    out.stalled = stalled.map((c) => c.job);
    const { data: accounts, error } = await db.from("accounts").select("id").limit(STALLED_ALERT_MAX_ACCOUNTS);
    if (error) return out;
    for (const account of (accounts ?? []) as Array<{ id: string }>) {
      for (const cron of stalled) {
        const r = await emitActiveAlert(db, {
          accountId: account.id,
          event: "dispatch.cron_stalled",
          subjectId: cron.job,
          now,
          data: {
            job: cron.job,
            label: cron.label ?? cron.job,
            last_ok_at: cron.last_ok_at,
            age_seconds: cron.age_s,
            expected_every_seconds: cron.expected_every_s ?? null,
            last_status: cron.last_status ?? null,
            last_error: cron.last_error ?? null,
          },
        });
        if (r.emitted) out.alerts++;
      }
    }
  } catch (err) {
    console.error("[Alertas] cron parado: falha ao avaliar:", err instanceof Error ? err.message : String(err));
  }
  return out;
}
