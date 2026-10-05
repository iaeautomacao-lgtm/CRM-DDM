import { describe, expect, it } from "vitest";
import { buildConversationOrigin, type OriginFirstMessage } from "./origin";

const msg = (over: Partial<OriginFirstMessage>): OriginFirstMessage => ({
  sender_type: "customer",
  content_type: "text",
  content_text: "Oi",
  template_name: null,
  campaign_id: null,
  created_at: "2026-10-05T12:00:00Z",
  ...over,
});
const none = { campaign: null, sent: null, agentName: null, flowName: null, originCampaignId: null };

describe("buildConversationOrigin", () => {
  it("resposta a campanha conta como ativo, com o que foi enviado", () => {
    const o = buildConversationOrigin({
      ...none,
      originCampaignId: "c1",
      campaign: { id: "c1", name: "Renegociação Outubro" },
      firstMessage: msg({ content_text: "quero negociar" }),
      sent: { template_name: "cobranca_v2", text: "Olá Ana, temos uma proposta…", sent_at: "2026-10-02T14:03:00Z" },
    });
    expect(o).toMatchObject({
      direction: "ativo",
      initiator: "campaign",
      headline: "Ativo · campanha Renegociação Outubro (template cobranca_v2)",
      opening_text: "Olá Ana, temos uma proposta…",
      opened_at: "2026-10-02T14:03:00Z",
    });
  });

  it("cliente escreveu antes do disparo continua receptivo", () => {
    const o = buildConversationOrigin({
      ...none,
      originCampaignId: "c1",
      campaign: { id: "c1", name: "Outubro" },
      firstMessage: msg({ created_at: "2026-10-01T10:00:00Z" }),
      sent: { template_name: "t", text: "oferta", sent_at: "2026-10-03T10:00:00Z" },
    });
    expect(o).toMatchObject({ direction: "receptivo", later_campaign: { id: "c1", name: "Outubro" } });
    expect(o.headline).toContain("depois respondeu à campanha Outubro");
  });

  it("cliente escreveu primeiro = receptivo", () => {
    const o = buildConversationOrigin({ ...none, firstMessage: msg({ content_text: "Boa tarde" }) });
    expect(o).toMatchObject({ direction: "receptivo", initiator: "customer", opening_text: "Boa tarde" });
  });

  it("atendente iniciou com template", () => {
    const o = buildConversationOrigin({
      ...none,
      agentName: "João",
      firstMessage: msg({ sender_type: "agent", content_text: null, content_type: "template", template_name: "boas_vindas" }),
    });
    expect(o.headline).toBe("Ativo · iniciada por João (template boas_vindas)");
    expect(o.opening_text).toBe("Template boas_vindas");
  });

  it("bot: fluxo quando houve execução, senão automação", () => {
    expect(buildConversationOrigin({ ...none, flowName: "Cobrança", firstMessage: msg({ sender_type: "bot" }) }).initiator).toBe("flow");
    expect(buildConversationOrigin({ ...none, firstMessage: msg({ sender_type: "bot" }) }).initiator).toBe("automation");
  });

  it("sem mensagens", () => {
    expect(buildConversationOrigin({ ...none, firstMessage: null }).direction).toBe("desconhecido");
  });
});
