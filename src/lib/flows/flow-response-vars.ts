// PRD 21, PR-21.1 — entrega a resposta de um WhatsApp Flow ao run ativo do contato como VARIÁVEIS (`flow_*`).
// Só dados: não avança nó, não chama efetivação de acordo. O fluxo da operação lê `{{vars.flow_parcelas}}` & cia.
//
// Revisão de fluxos: quando a resposta traz o `flow_token` do nó send_flow (`fr:<id do run>`), a entrega vai para ESSE run (se ainda estiver ativo e for
// do mesmo contato) em vez de "o run ativo mais recente do contato" — assim a resposta de um formulário enviado por um fluxo não cai num outro fluxo
// que começou depois. Sem token (ou token de campanha `dq:`, ou run que já terminou) mantém o comportamento de antes: o run ativo mais recente.
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseFlowToken } from "@/lib/whatsapp/flow-token";

export type FlowResponseDelivery = "token_run" | "latest_active" | null;

type Db = Pick<SupabaseClient, "from">;
interface RunRow {
  id: string;
  vars: Record<string, unknown> | null;
}

async function findRun(db: Db, accountId: string, contactId: string, runId?: string): Promise<RunRow | null> {
  let query = db.from("flow_runs").select("id, vars").eq("account_id", accountId).eq("contact_id", contactId).eq("status", "active");
  if (runId) query = query.eq("id", runId);
  const { data, error } = await query.order("started_at", { ascending: false }).limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0] as RunRow;
}

/**
 * Mescla `vars` no `flow_runs.vars` do run ativo (não o `paused_by_agent`: ele não é mais do fluxo). Devolve para qual run foi
 * (`token_run` = o que enviou o formulário; `latest_active` = o mais recente do contato) ou null se não havia run ativo. Nunca lança.
 */
export async function deliverFlowResponse(
  db: Db,
  input: { accountId: string; contactId: string; vars: Record<string, string>; flowToken?: unknown },
): Promise<FlowResponseDelivery> {
  if (Object.keys(input.vars).length === 0) return null;
  try {
    const parsed = parseFlowToken(input.flowToken);
    let delivery: FlowResponseDelivery = "token_run";
    let run = parsed?.kind === "run" ? await findRun(db, input.accountId, input.contactId, parsed.id) : null;
    if (!run) {
      delivery = "latest_active";
      run = await findRun(db, input.accountId, input.contactId);
    }
    if (!run) return null;
    const { error: updateError } = await db
      .from("flow_runs")
      .update({ vars: { ...(run.vars ?? {}), ...input.vars } })
      .eq("id", run.id);
    return updateError ? null : delivery;
  } catch {
    return null;
  }
}

/** Versão booleana (PR 21.1): true = entregue em algum run ativo. */
export async function deliverFlowResponseToActiveRun(
  db: Db,
  input: { accountId: string; contactId: string; vars: Record<string, string>; flowToken?: unknown },
): Promise<boolean> {
  return (await deliverFlowResponse(db, input)) !== null;
}
