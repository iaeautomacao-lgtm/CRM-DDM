// Origem da conversa (PRD-02): quem iniciou — o cliente (receptivo) ou nós
// (ativo) — e, se fomos nós, o que foi enviado. Puro: a rota
// /api/conversations/[id]/origin busca os dados e este módulo decide.
//
// Regra:
//   - Conversa ligada a uma campanha (origin_campaign_id, gravado quando o
//     cliente responde a um disparo — migration 126) ou cuja 1ª mensagem
//     veio de campanha → ATIVO por campanha, mesmo que a 1ª mensagem
//     registrada na conversa seja a resposta do cliente.
//   - Senão, a 1ª mensagem: cliente → RECEPTIVO; atendente → ATIVO
//     (atendente); bot → ATIVO (fluxo, se houve execução, senão automação/IA).

export type OriginInitiator = "customer" | "campaign" | "agent" | "flow" | "automation" | "unknown";

export interface OriginFirstMessage {
  sender_type: "customer" | "agent" | "bot" | string;
  content_type: string;
  content_text: string | null;
  template_name: string | null;
  campaign_id: string | null;
  created_at: string;
}

export interface OriginInput {
  originCampaignId: string | null;
  firstMessage: OriginFirstMessage | null;
  campaign: { id: string; name: string } | null;
  /** Item da fila que foi enviado ao contato (texto/template do disparo). */
  sent: { template_name: string | null; text: string | null; sent_at: string | null } | null;
  agentName: string | null;
  flowName: string | null;
}

export interface ConversationOrigin {
  /** "receptivo" = cliente escreveu primeiro; "ativo" = nós. */
  direction: "receptivo" | "ativo" | "desconhecido";
  initiator: OriginInitiator;
  /** Frase curta para a faixa do topo da conversa. */
  headline: string;
  campaign: { id: string; name: string } | null;
  template_name: string | null;
  /** O que abriu a conversa (texto, template ou mídia). */
  opening_text: string | null;
  opened_at: string | null;
  by: string | null;
}

function preview(m: OriginFirstMessage | null): string | null {
  if (!m) return null;
  if (m.content_text?.trim()) return m.content_text.trim().slice(0, 280);
  if (m.template_name) return `Template ${m.template_name}`;
  return m.content_type && m.content_type !== "text" ? `[${m.content_type}]` : null;
}

export function buildConversationOrigin(input: OriginInput): ConversationOrigin {
  const { firstMessage: first, campaign } = input;
  const campaignId = input.originCampaignId ?? first?.campaign_id ?? null;

  if (campaignId) {
    const template = input.sent?.template_name ?? first?.template_name ?? null;
    const name = campaign?.name ?? "campanha";
    return {
      direction: "ativo",
      initiator: "campaign",
      headline: `Ativo · campanha ${name}${template ? ` (template ${template})` : ""}`,
      campaign: campaign ?? { id: campaignId, name },
      template_name: template,
      opening_text: input.sent?.text ?? (first?.campaign_id ? preview(first) : null) ?? (template ? `Template ${template}` : null),
      opened_at: input.sent?.sent_at ?? first?.created_at ?? null,
      by: "Disparador",
    };
  }

  if (!first) {
    return {
      direction: "desconhecido",
      initiator: "unknown",
      headline: "Sem mensagens ainda",
      campaign: null,
      template_name: null,
      opening_text: null,
      opened_at: null,
      by: null,
    };
  }

  const base = {
    campaign: null,
    template_name: first.template_name,
    opening_text: preview(first),
    opened_at: first.created_at,
  };
  if (first.sender_type === "customer") {
    return { ...base, direction: "receptivo", initiator: "customer", headline: "Receptivo · o cliente escreveu primeiro", by: "Cliente" };
  }
  if (first.sender_type === "agent") {
    const who = input.agentName ?? "atendente";
    return {
      ...base,
      direction: "ativo",
      initiator: "agent",
      headline: `Ativo · iniciada por ${who}${first.template_name ? ` (template ${first.template_name})` : ""}`,
      by: who,
    };
  }
  if (input.flowName) {
    return { ...base, direction: "ativo", initiator: "flow", headline: `Ativo · fluxo ${input.flowName}`, by: input.flowName };
  }
  return { ...base, direction: "ativo", initiator: "automation", headline: "Ativo · automação/IA", by: "Automação" };
}
