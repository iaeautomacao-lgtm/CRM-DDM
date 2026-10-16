// Leitura da configuração de SLA (servidor). Sempre escopada pela conta. Tolerante: sem a migration 381 (coluna) ou sem a 231 (account_settings)
// vale o padrão de 15 minutos; qualquer falha de leitura também (o painel nunca quebra por causa da meta).
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SLA_CONFIG, SLA_FALLBACK_MINUTES, slaMinutesOrNull, type SlaConfig } from "@/lib/sla/config";

type Db = Pick<SupabaseClient, "from">;

export const SLA_SETTING_KEY = "first_response_sla_min";

export async function loadSlaConfig(db: Db, accountId: string): Promise<SlaConfig> {
  let defaultMin = SLA_FALLBACK_MINUTES;
  let defaultSource: SlaConfig["defaultSource"] = "default";
  const teams: SlaConfig["teams"] = {};
  try {
    const [setting, rows] = await Promise.all([
      db.from("account_settings").select("value").eq("account_id", accountId).eq("key", SLA_SETTING_KEY).limit(1),
      db.from("teams").select("id, first_response_sla_min").eq("account_id", accountId).limit(1000),
    ]);
    if (!setting.error) {
      const stored = slaMinutesOrNull(((setting.data ?? [])[0] as { value?: unknown } | undefined)?.value);
      if (stored !== null) {
        defaultMin = stored;
        defaultSource = "account";
      }
    }
    if (!rows.error) {
      for (const r of (rows.data ?? []) as Array<{ id: string; first_response_sla_min: unknown }>) teams[r.id] = slaMinutesOrNull(r.first_response_sla_min);
    }
  } catch {
    return { ...DEFAULT_SLA_CONFIG, teams: {} };
  }
  return { defaultMin, defaultSource, teams };
}
