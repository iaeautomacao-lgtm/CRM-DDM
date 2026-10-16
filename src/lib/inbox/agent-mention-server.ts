import { supabaseAdmin } from "@/lib/flows/admin-client";
import { writeLog } from "@/lib/logger";
import { mentionedAgentAlias } from "./agent-mention";

// @operador (migration 376): o cliente escreve "@apelido ..." no INÍCIO da mensagem e a conversa vai para a fila de espera
// daquele operador (conversations.requested_agent_id), sem fluxo, IA ou rodízio. Prioridade na distribuição: menção > dono do
// contato (carteira, src/lib/carteira/owner-preference.ts) > rodízio. LGPD: log só com ids, nunca telefone, nome ou texto.

// Chamado só depois que um webhook autenticado do provedor gravou a mensagem do cliente. Nenhum LLM nem entrada do navegador
// decide o destino. true = a conversa foi para a fila do operador (quem chamou trata a mensagem como já tratada).
export async function tryMentionAgentHandoff(input: {
  accountId: string;
  conversationId: string;
  text: string | null | undefined;
}): Promise<boolean> {
  const alias = mentionedAgentAlias(input.text);
  if (!alias) return false;
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("route_conversation_to_mentioned_agent", {
    p_account_id: input.accountId,
    p_conversation_id: input.conversationId,
    p_alias: alias,
  });
  if (error) {
    // Antes da migration 376 a RPC não existe (42883/PGRST202): sem menção, o fluxo normal segue.
    if (error.code === "42883" || error.code === "PGRST202") return false;
    console.error("[agent-mention] falha ao rotear:", error.code ?? "sem_codigo");
    // Falha fechada: uma menção válida não deve cair na IA se o roteamento falhou; o webhook responde erro e o provedor reenvia.
    throw error;
  }
  if (!data) return false;
  void writeLog({
    account_id: input.accountId, level: "info", source: "flows",
    event: "agent_mention_handoff",
    message: "Cliente solicitou atendimento por operador",
    payload: { conversation_id: input.conversationId, agent_id: data },
  });
  return true;
}

type ReservationDb = { from: (table: string) => unknown };

// A conversa está reservada a um operador (menção pendente)? Usado pelos caminhos automáticos que transferem conversa
// (nó handoff_team do fluxo, travas da IA): com reserva, eles não mexem na atribuição. Falha aberta: coluna inexistente
// (376 ainda não aplicada) ou erro de leitura = sem reserva, o comportamento de antes.
export async function hasMentionReservation(db: ReservationDb, conversationId: string | null | undefined): Promise<boolean> {
  if (!conversationId) return false;
  try {
    const q = (db as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }> } } } })
      .from("conversations").select("requested_agent_id").eq("id", conversationId).limit(1);
    const { data, error } = await q;
    if (error) return false;
    return Boolean(((data ?? []) as Array<{ requested_agent_id?: string | null }>)[0]?.requested_agent_id);
  } catch {
    return false;
  }
}
