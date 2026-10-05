import { describe, expect, it } from "vitest";
import { parseSocialWebhook, socialAttachmentContentType } from "./inbound";

describe("parseSocialWebhook", () => {
  it("lê mensagem de texto do Instagram", () => {
    const events = parseSocialWebhook({
      object: "instagram",
      entry: [
        {
          id: "IG1",
          messaging: [
            {
              sender: { id: "USER1" },
              recipient: { id: "IG1" },
              timestamp: 1700000000000,
              message: { mid: "m1", text: "oi", reply_to: { mid: "m0" } },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      {
        type: "instagram",
        accountExternalId: "IG1",
        senderId: "USER1",
        timestamp: 1700000000000,
        mid: "m1",
        text: "oi",
        replyId: null,
        attachments: [],
        replyToMid: "m0",
      },
    ]);
  });

  it("object=page vira messenger e quick_reply vira replyId", () => {
    const [ev] = parseSocialWebhook({
      object: "page",
      entry: [
        {
          id: "PAGE1",
          messaging: [{ sender: { id: "PSID" }, message: { mid: "m2", text: "Sim", quick_reply: { payload: "yes" } } }],
        },
      ],
    });
    expect(ev.type).toBe("messenger");
    expect(ev.replyId).toBe("yes");
  });

  it("postback usa título como texto e payload como replyId", () => {
    const [ev] = parseSocialWebhook({
      object: "page",
      entry: [{ id: "P", messaging: [{ sender: { id: "S" }, postback: { mid: "pb1", title: "Falar", payload: "talk" } }] }],
    });
    expect(ev).toMatchObject({ mid: "pb1", text: "Falar", replyId: "talk", attachments: [] });
  });

  it("ignora ecos, eventos sem mid e objetos desconhecidos", () => {
    expect(
      parseSocialWebhook({
        object: "instagram",
        entry: [
          {
            id: "IG1",
            messaging: [
              { sender: { id: "IG1" }, message: { mid: "e1", text: "nossa", is_echo: true } },
              { sender: { id: "U" }, read: { mid: "x" } },
              { sender: { id: "U" }, message: { text: "sem mid" } },
            ],
          },
        ],
      })
    ).toEqual([]);
    expect(parseSocialWebhook({ object: "whatsapp_business_account", entry: [] })).toEqual([]);
    expect(parseSocialWebhook(null)).toEqual([]);
  });

  it("mapeia anexos", () => {
    const [ev] = parseSocialWebhook({
      object: "instagram",
      entry: [
        {
          id: "IG1",
          messaging: [
            { sender: { id: "U" }, message: { mid: "m3", attachments: [{ type: "image", payload: { url: "https://x/y.jpg" } }] } },
          ],
        },
      ],
    });
    expect(ev.attachments).toEqual([{ type: "image", url: "https://x/y.jpg" }]);
  });
});

describe("socialAttachmentContentType", () => {
  it("converte tipos da Meta", () => {
    expect(socialAttachmentContentType("image")).toBe("image");
    expect(socialAttachmentContentType("ig_reel")).toBe("video");
    expect(socialAttachmentContentType("audio")).toBe("audio");
    expect(socialAttachmentContentType("file")).toBe("document");
    expect(socialAttachmentContentType("story_mention")).toBe("text");
  });
});
