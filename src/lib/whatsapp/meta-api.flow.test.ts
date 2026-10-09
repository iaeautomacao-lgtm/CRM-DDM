// PRD 21.4 — mensagem interativa que abre um WhatsApp Flow (interactive.type = 'flow').
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendInteractiveFlow } from "./meta-api";

const BASE = {
  phoneNumberId: "pn-1",
  accessToken: "tok",
  to: "5521999990001",
  bodyText: "Toque no botão para negociar",
  flowId: "495819284729182",
  flowToken: "fr:11111111-1111-4111-8111-111111111111",
  ctaText: "Negociar",
} as const;

describe("sendInteractiveFlow", () => {
  let sent: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(() => {
    sent = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("data_exchange: payload sem flow_action_payload; token, id e CTA no lugar certo; header/footer opcionais", async () => {
    const r = await sendInteractiveFlow({ ...BASE, flowAction: "data_exchange", headerText: "Proposta", footerText: "DDM" });
    expect(r.messageId).toBe("wamid.X");
    expect(sent[0].url).toContain("/pn-1/messages");
    expect(sent[0].body).toMatchObject({
      messaging_product: "whatsapp",
      to: "5521999990001",
      type: "interactive",
      interactive: {
        type: "flow",
        header: { type: "text", text: "Proposta" },
        body: { text: "Toque no botão para negociar" },
        footer: { text: "DDM" },
        action: {
          name: "flow",
          parameters: { flow_message_version: "3", flow_token: BASE.flowToken, flow_id: BASE.flowId, flow_cta: "Negociar", flow_action: "data_exchange" },
        },
      },
    });
    const params = ((sent[0].body.interactive as { action: { parameters: Record<string, unknown> } }).action.parameters);
    expect(params).not.toHaveProperty("flow_action_payload");
  });

  it("navigate: leva a tela inicial em flow_action_payload.screen", async () => {
    await sendInteractiveFlow({ ...BASE, flowAction: "navigate", screenId: "SELECAO_PARCELAS" });
    const params = ((sent[0].body.interactive as { action: { parameters: Record<string, unknown> } }).action.parameters);
    expect(params.flow_action_payload).toEqual({ screen: "SELECAO_PARCELAS" });
  });

  it("valida antes de chamar a Meta: id não numérico, CTA vazia/longa, navigate sem tela, token vazio", async () => {
    await expect(sendInteractiveFlow({ ...BASE, flowId: "abc", flowAction: "data_exchange" })).rejects.toThrow(/numeric/);
    await expect(sendInteractiveFlow({ ...BASE, ctaText: "", flowAction: "data_exchange" })).rejects.toThrow(/CTA/);
    await expect(sendInteractiveFlow({ ...BASE, ctaText: "x".repeat(31), flowAction: "data_exchange" })).rejects.toThrow(/CTA/);
    await expect(sendInteractiveFlow({ ...BASE, flowAction: "navigate" })).rejects.toThrow(/screenId/);
    await expect(sendInteractiveFlow({ ...BASE, flowToken: "", flowAction: "data_exchange" })).rejects.toThrow(/token/);
    expect(sent).toEqual([]);
  });
});
