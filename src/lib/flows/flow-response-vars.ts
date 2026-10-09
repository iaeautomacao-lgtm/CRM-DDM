// PRD 21, PR-21.1 — entrega a resposta de um WhatsApp Flow ao run ativo do contato como VARIÁVEIS (`flow_*`).
// Só dados: não avança nó, não chama efetivação de acordo. O fluxo da operação lê `{{vars.flow_parcelas}}` & cia.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Mescla `vars` no `flow_runs.vars` do run ativo (não o `paused_by_agent`: ele não é mais do fluxo). false = sem run ativo. Nunca lança. */
export async function deliverFlowResponseToActiveRun(
  db: Pick<SupabaseClient, "from">,
  input: { accountId: string; contactId: string; vars: Record<string, string> },
): Promise<boolean> {
  if (Object.keys(input.vars).length === 0) return false;
  try {
    const { data, error } = await db
      .from("flow_runs")
      .select("id, vars")
      .eq("account_id", input.accountId)
      .eq("contact_id", input.contactId)
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return false;
    const run = data[0] as { id: string; vars: Record<string, unknown> | null };
    const { error: updateError } = await db
      .from("flow_runs")
      .update({ vars: { ...(run.vars ?? {}), ...input.vars } })
      .eq("id", run.id);
    return !updateError;
  } catch {
    return false;
  }
}
