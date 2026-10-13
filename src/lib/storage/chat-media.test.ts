import { describe, expect, it } from "vitest";
import { chatMediaReference, isChatMediaRef } from "./chat-media";

const ACC = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("isChatMediaRef", () => {
  it("aceita a referência gerada por chatMediaReference (inclusive com acento e espaço)", () => {
    expect(isChatMediaRef(chatMediaReference(`account-${ACC}/abc-foto.png`))).toBe(true);
    expect(isChatMediaRef(chatMediaReference(`account-${ACC}/abc-relatório final.pdf`), ACC)).toBe(true);
    expect(isChatMediaRef(chatMediaReference(`account-${ACC}/sub/x.ogg`), ACC)).toBe(true);
  });

  it("com accountId, exige a pasta da própria conta", () => {
    expect(isChatMediaRef(chatMediaReference(`account-${OTHER}/x.png`), ACC)).toBe(false);
    expect(isChatMediaRef(chatMediaReference(`account-${OTHER}/x.png`))).toBe(true); // sem accountId só confere o formato
  });

  it("recusa URL externa, outra rota, caminho cru e valores que não são texto", () => {
    for (const bad of [
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "javascript:alert(1)",
      "data:text/html,x",
      `account-${ACC}/x.png`,
      "/api/outra-rota/x",
      `https://x.supabase.co/storage/v1/object/public/chat-media/account-${ACC}/x.png`,
      "/api/chat-media/",
      "/api/chat-media/meta/legado.png",
      `/api/chat-media/account-${ACC}/`,
      "",
    ]) {
      expect(isChatMediaRef(bad, ACC), bad).toBe(false);
    }
    for (const v of [null, undefined, 42, {}, []]) expect(isChatMediaRef(v)).toBe(false);
  });

  it("recusa travessia e disfarces: .., query, âncora, barra invertida, %2e/%2f/%5c, controle e URL enorme", () => {
    for (const rest of ["../x.png", "a/../b.png", "x.png?t=1", "x.png#f", "a\b.png", "%2e%2e/x.png", "a%2Fb.png", "a%5Cb.png", "a\nb.png"]) {
      expect(isChatMediaRef(`/api/chat-media/account-${ACC}/${rest}`, ACC), rest).toBe(false);
    }
    expect(isChatMediaRef(`/api/chat-media/account-${ACC}/${"x".repeat(700)}`, ACC)).toBe(false);
  });
});
