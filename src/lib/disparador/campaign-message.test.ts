import { describe, expect, it } from "vitest";
import {
  campaignContentType,
  campaignMessageStatus,
  campaignMessageText,
  matchQueueItemByProviderId,
  providerMessageKey,
  renderMetaTemplateBody,
} from "./campaign-message";
import { EXTERNAL_WAHA_TEXT_MARKER } from "./queue-markers";

describe("providerMessageKey", () => {
  it("returns the last segment of a WAHA serialized id", () => {
    expect(providerMessageKey("true_5511999999999@c.us_3EB0ABC")).toBe("3EB0ABC");
  });
  it("keeps Meta wamids intact", () => {
    expect(providerMessageKey("wamid.HBgLNTUxMTk5OTk5")).toBe("wamid.HBgLNTUxMTk5OTk5");
  });
});

describe("matchQueueItemByProviderId", () => {
  const items = [
    { id: "a", waha_message_id: "wamid.AAA" },
    { id: "b", waha_message_id: "true_5511@c.us_3EB0KEY" },
    { id: "c", waha_message_id: null },
  ];
  it("matches the exact provider id (Meta context.id)", () => {
    expect(matchQueueItemByProviderId(items, "wamid.AAA")?.id).toBe("a");
  });
  it("matches a WAHA quote that only carries the key", () => {
    expect(matchQueueItemByProviderId(items, "3EB0KEY")?.id).toBe("b");
  });
  it("returns null when the quoted message is not a campaign send", () => {
    expect(matchQueueItemByProviderId(items, "wamid.OTHER")).toBeNull();
  });
});

describe("renderMetaTemplateBody", () => {
  it("replaces numbered placeholders, repeated ones included", () => {
    expect(renderMetaTemplateBody("Oi {{1}}, {{1}} deve {{2}}", ["Ana", "R$ 10"])).toBe(
      "Oi Ana, Ana deve R$ 10"
    );
  });
  it("turns markdown links into the bare URL, like the Meta send path", () => {
    expect(renderMetaTemplateBody("Pague: {{1}}", ["[boleto](https://x.y/b)"])).toBe(
      "Pague: https://x.y/b"
    );
  });
});

describe("campaignMessageText", () => {
  it("renders the Meta template body when it is known", () => {
    expect(
      campaignMessageText(
        { template_name: "cobranca", template_variables: ["Ana"], mensagem_final: "ignored" },
        { templateBody: "Olá {{1}}", loggedText: "logged" }
      )
    ).toBe("Olá Ana");
  });
  it("prefers the logged send text for free-text sends", () => {
    expect(
      campaignMessageText(
        { template_name: null, template_variables: null, mensagem_final: "Oi {{nome}}" },
        { loggedText: "Oi Ana" }
      )
    ).toBe("Oi Ana");
  });
  it("reads template_variables[0] for external WAHA contacts", () => {
    expect(
      campaignMessageText(
        {
          template_name: EXTERNAL_WAHA_TEXT_MARKER,
          template_variables: ["Texto real"],
          mensagem_final: "+5511999999999",
        },
        {}
      )
    ).toBe("Texto real");
  });
  it("falls back to mensagem_final", () => {
    expect(
      campaignMessageText(
        { template_name: null, template_variables: null, mensagem_final: "Oi" },
        {}
      )
    ).toBe("Oi");
  });
});

describe("campaignContentType / campaignMessageStatus", () => {
  it("maps queue tipo and template to messages.content_type", () => {
    expect(campaignContentType({ tipo: "texto", template_name: "t" })).toBe("template");
    expect(campaignContentType({ tipo: "imagem", template_name: null })).toBe("image");
    expect(campaignContentType({ tipo: "arquivo", template_name: null })).toBe("document");
    expect(
      campaignContentType({ tipo: "texto", template_name: EXTERNAL_WAHA_TEXT_MARKER })
    ).toBe("text");
  });
  it("maps queue status to messages.status", () => {
    expect(campaignMessageStatus("lido")).toBe("read");
    expect(campaignMessageStatus("entregue")).toBe("delivered");
    expect(campaignMessageStatus("enviado")).toBe("sent");
  });
});
