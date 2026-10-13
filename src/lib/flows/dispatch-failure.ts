// Decisão do dono (13/10, item 12): quando a entrega da mensagem do cliente ao fluxo FALHA (exceção em dispatchInboundToFlows), NINGUÉM responde por cima
// (nem IA global nem automação: o despacho devolve consumed:true) e a conversa vai para a FILA (status 'pending', em espera), com o motivo registrado em
// `ai_decisions` (decision_type 'handoff', handoff_reason FALHA_ENTREGA_FLUXO — aparece com os demais motivos de transferência). Melhor esforço em cada
// passo: nunca lança. O registro técnico (system_logs) continua sendo feito pelo chamador.
import type { SupabaseClient } from "@supabase/supabase-js";

export const DISPATCH_FAILURE_REASON = "FALHA_ENTREGA_FLUXO";

type Db = Pick<SupabaseClient, "from">;

export async function queueAfterDispatchFailure(
  db: Db,
  input: { accountId: string; contactId: string; conversationId?: string | null },
  detail: string,
): Promise<{ queued: boolean; recorded: boolean }> {
  let queued = false;
  let recorded = false;
  if (input.conversationId) {
    try {
      // 'closed' fica como está (a mensagem nova reabre a conversa pelo caminho normal); aberta ou já em espera vai/continua na fila
      const { data, error } = await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", input.conversationId)
        .eq("account_id", input.accountId)
        .neq("status", "closed")
        .select("id");
      queued = !error && Array.isArray(data) && data.length > 0;
    } catch {
      queued = false;
    }
  }
  try {
    const { error } = await db.from("ai_decisions").insert({
      account_id: input.accountId,
      conversation_id: input.conversationId ?? null,
      decision_type: "handoff",
      decision: { kind: "dispatch_failure", queued, detail: detail.slice(0, 200) },
      reason: "flow_dispatch_failed",
      needs_human: true,
      handoff_reason: DISPATCH_FAILURE_REASON,
    });
    recorded = !error;
  } catch {
    recorded = false;
  }
  return { queued, recorded };
}
