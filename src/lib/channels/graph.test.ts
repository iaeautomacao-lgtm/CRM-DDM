import { describe, expect, it } from "vitest";
import { buildSendBody, QUICK_REPLY_LIMITS, socialWindow } from "./graph";

const base = { type: "instagram" as const, accountExternalId: "IG1", accessToken: "t", recipientId: "U1" };

describe("buildSendBody", () => {
  it("texto dentro da janela usa RESPONSE", () => {
    expect(buildSendBody({ ...base, message: { kind: "text", text: "oi" } })).toEqual({
      recipient: { id: "U1" },
      messaging_type: "RESPONSE",
      message: { text: "oi" },
    });
  });

  it("fora da janela usa a tag HUMAN_AGENT", () => {
    const body = buildSendBody({ ...base, humanAgentTag: true, message: { kind: "text", text: "oi" } });
    expect(body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });

  it("limita quick replies e corta títulos", () => {
    const quickReplies = Array.from({ length: 20 }, (_, i) => ({ title: `Opção muito longa número ${i}`, payload: `p${i}` }));
    const body = buildSendBody({ ...base, message: { kind: "text", text: "Escolha", quickReplies } }) as {
      message: { quick_replies: Array<{ content_type: string; title: string; payload: string }> };
    };
    expect(body.message.quick_replies).toHaveLength(QUICK_REPLY_LIMITS.max);
    expect(body.message.quick_replies[0]).toEqual({
      content_type: "text",
      title: "Opção muito longa número 0".slice(0, QUICK_REPLY_LIMITS.titleMax),
      payload: "p0",
    });
  });

  it("anexo vai como attachment com url", () => {
    expect(buildSendBody({ ...base, message: { kind: "attachment", mediaType: "image", url: "https://x" } })).toMatchObject({
      message: { attachment: { type: "image", payload: { url: "https://x" } } },
    });
  });
});

describe("socialWindow", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  it("aberta nas primeiras 24h", () => {
    expect(socialWindow(hoursAgo(1), now)).toBe("open");
    expect(socialWindow(hoursAgo(23.9), now)).toBe("open");
  });
  it("só atendente humano entre 24h e 7 dias", () => {
    expect(socialWindow(hoursAgo(24), now)).toBe("human_agent");
    expect(socialWindow(hoursAgo(24 * 7 - 1), now)).toBe("human_agent");
  });
  it("fechada depois de 7 dias ou sem mensagem do cliente", () => {
    expect(socialWindow(hoursAgo(24 * 7), now)).toBe("closed");
    expect(socialWindow(null, now)).toBe("closed");
  });
});
