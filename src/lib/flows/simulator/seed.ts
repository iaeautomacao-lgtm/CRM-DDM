// Leituras reais (só SELECT) que alimentam o banco em memória do simulador, comuns ao "Testar fluxo"
// (POST /api/flows/[id]/simulate) e ao "Testar agente" (POST /api/settings/agents/[id]/simulate).
// Servidor; sempre escopado pela conta.

import type { supabaseAdmin } from "@/lib/flows/admin-client";
import type { SimulationSeed } from "./run";

type Admin = ReturnType<typeof supabaseAdmin>;

export type SimulationAccountData = Pick<SimulationSeed, "aiConfig" | "knowledgeBase" | "teams" | "aiTools" | "accountSecrets">;

export async function loadSimulationAccountData(admin: Admin, accountId: string): Promise<SimulationAccountData> {
  const [aiConfigRes, kbRes, teamsRes, toolsRes, secretsRes] = await Promise.all([
    admin.from("ai_config").select("*").eq("account_id", accountId).limit(1),
    admin.from("knowledge_base_files").select("id, name, content").eq("account_id", accountId).range(0, 199),
    admin.from("teams").select("id, name").eq("account_id", accountId).range(0, 499),
    // Catálogo de ferramentas e nomes/hosts das credenciais: só SELECT, sem valores secretos
    // (account_secrets: nunca value_encrypted — o simulador mostra credenciais como ***).
    admin.from("ai_tools").select("*").eq("account_id", accountId).range(0, 499),
    admin.from("account_secrets").select("name, kind, value_plain, allowed_hosts").eq("account_id", accountId).range(0, 499),
  ]);
  return {
    aiConfig: (aiConfigRes.data?.[0] as Record<string, unknown> | undefined) ?? null,
    knowledgeBase: (kbRes.data ?? []) as Array<{ id?: string; name: string; content: string }>,
    teams: (teamsRes.data ?? []) as Array<{ id: string; name: string }>,
    aiTools: (toolsRes.data ?? []) as Array<Record<string, unknown>>,
    accountSecrets: (secretsRes.data ?? []) as Array<{
      name: string;
      kind: string;
      value_plain: string | null;
      allowed_hosts: string[] | null;
    }>,
  };
}
