import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeSignature, generateWebhookSecret, signatureHeader, verifyWebhookSignature } from "./signature";
import { isWebhookEvent, parseWebhookEvents, WEBHOOK_EVENTS } from "./catalog";

const SECRET = "whsec_teste";
const BODY = '{"id":"e1","type":"message.received","data":{"text":"olá"}}';
const NOW = Date.UTC(2026, 9, 9, 15, 0, 0);

describe("assinatura X-CRM-Signature", () => {
  it("formato t=<unix>,v1=<hex HMAC_SHA256(segredo, t + '.' + corpo)>", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    const t = Math.floor(NOW / 1000);
    expect(header).toBe(`t=${t},v1=${computeSignature(SECRET, t, BODY)}`);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("o receptor valida o corpo bruto dentro da janela de 5 minutos", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifyWebhookSignature(SECRET, BODY, header, NOW)).toEqual({ ok: true });
    expect(verifyWebhookSignature(SECRET, BODY, header, NOW + 299_000)).toEqual({ ok: true });
    expect(verifyWebhookSignature(SECRET, BODY, header, NOW - 299_000)).toEqual({ ok: true });
  });

  it("rejeita replay (|agora − t| > 5 min), corpo alterado, outro segredo e cabeçalho malformado", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifyWebhookSignature(SECRET, BODY, header, NOW + 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(verifyWebhookSignature(SECRET, BODY, header, NOW - 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(verifyWebhookSignature(SECRET, BODY.replace("olá", "oi"), header, NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature("whsec_outro", BODY, header, NOW)).toEqual({ ok: false, reason: "mismatch" });
    for (const bad of [null, undefined, "", "lixo", "t=abc,v1=00", `t=${Math.floor(NOW / 1000)},v1=zz`, `v1=${"0".repeat(64)}`]) {
      expect(verifyWebhookSignature(SECRET, BODY, bad as string, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("assinatura de t diferente não vale para o mesmo corpo (t entra no HMAC)", () => {
    const t = Math.floor(NOW / 1000);
    const forged = `t=${t + 10},v1=${computeSignature(SECRET, t, BODY)}`;
    expect(verifyWebhookSignature(SECRET, BODY, forged, NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("segredo gerado: whsec_ + 32 bytes base64url, sempre diferente", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

describe("catálogo de eventos", () => {
  it("valida, deduplica e recusa evento desconhecido/vazio", () => {
    expect(parseWebhookEvents(["message.received", "message.received", "agreement.created"])).toEqual(["message.received", "agreement.created"]);
    expect(parseWebhookEvents([])).toBeNull();
    expect(parseWebhookEvents(["message.received", "inventado"])).toBeNull();
    expect(parseWebhookEvents("message.received")).toBeNull();
    expect(WEBHOOK_EVENTS.every(isWebhookEvent)).toBe(true);
    expect(isWebhookEvent("webhook.test")).toBe(false); // o teste nunca se "assina"
  });

  it("os eventos do catálogo são exatamente os que os triggers da migration 204 emitem", () => {
    const sql = readFileSync("supabase/migrations/204_outbound_webhooks.sql", "utf8");
    const emitted = new Set([...sql.matchAll(/enqueue_webhook_event\([^,]+,\s*'([a-z_.]+)'/g)].map((m) => m[1]));
    expect([...emitted].sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });
});
