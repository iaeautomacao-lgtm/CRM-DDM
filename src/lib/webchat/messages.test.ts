import { describe, expect, it } from "vitest";
import {
  WEBCHAT_ALLOWED_MIME,
  mediaKindFromMime,
  safeUploadName,
  toClientMessage,
  webchatMediaHref,
} from "./messages";

describe("webchat messages", () => {
  it("routes private chat-media through the token-scoped media route", () => {
    expect(webchatMediaHref("tok", "/api/chat-media/account-1/webchat/s/a.png")).toBe(
      "/api/webchat/tok/media?ref=%2Fapi%2Fchat-media%2Faccount-1%2Fwebchat%2Fs%2Fa.png"
    );
  });

  it("keeps external media URLs as they are", () => {
    expect(webchatMediaHref("tok", "https://cdn.example.com/x.jpg")).toBe("https://cdn.example.com/x.jpg");
    expect(webchatMediaHref("tok", null)).toBeNull();
  });

  it("maps mime types to message kinds", () => {
    expect(mediaKindFromMime("image/png")).toBe("image");
    expect(mediaKindFromMime("audio/webm")).toBe("audio");
    expect(mediaKindFromMime("video/mp4")).toBe("video");
    expect(mediaKindFromMime("application/pdf")).toBe("document");
  });

  it("only allows known file types from the customer", () => {
    expect(WEBCHAT_ALLOWED_MIME.test("image/jpeg")).toBe(true);
    expect(WEBCHAT_ALLOWED_MIME.test("application/pdf")).toBe(true);
    expect(WEBCHAT_ALLOWED_MIME.test("text/html")).toBe(false);
    expect(WEBCHAT_ALLOWED_MIME.test("application/x-msdownload")).toBe(false);
  });

  it("sanitizes upload names", () => {
    expect(safeUploadName("../../Comprovante de pagamento (1).pdf")).toBe(
      ".._.._Comprovante_de_pagamento_1_.pdf"
    );
    expect(safeUploadName("")).toBe("arquivo");
    expect(safeUploadName("a/b\\c.png")).not.toMatch(/[/\\]/);
  });

  it("sends the customer only what the page renders", () => {
    const msg = toClientMessage("tok", {
      id: "m1",
      sender_type: "agent",
      content_type: "text",
      content_text: "Olá",
      media_url: null,
      interactive_payload: null,
      created_at: "2026-10-02T12:00:00Z",
    });
    expect(msg).toEqual({
      id: "m1",
      from: "business",
      content_type: "text",
      text: "Olá",
      media_url: null,
      interactive: null,
      created_at: "2026-10-02T12:00:00Z",
    });
  });
});
