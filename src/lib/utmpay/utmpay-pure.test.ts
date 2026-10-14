import { describe, expect, it } from "vitest";

import { computeAttribution } from "./attribution";
import { normalizeUtmpayBaseUrl, utmpayEventsUrl, validateUtmpayConfigBody, viewUtmpayConfig } from "./config-api";
import { parseUtmpayEvent, peekTid, withinAttributionWindow } from "./events";
import { signUtmpayBody, verifyUtmpaySignature } from "./signature";
import { findFirstUrl, findFirstUrlInVariables, replaceFoundUrl } from "./urls";
import { parseBatchResponse } from "./client";
import { alunoIdFor, cpfDigits } from "./links";
import { buildFunnelView, rate, toBadge } from "./stats";

const SECRET = "segredo-de-teste";
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const ts = (offsetS = 0) => String(Math.floor(NOW / 1000) + offsetS);

describe("assinatura (X-UTMpay-Signature)", () => {
  const body = '{"event_id":"x","tid":"t1"}';
  it("aceita HMAC_SHA256(secret, timestamp + '.' + corpo) em hex com o prefixo sha256=", () => {
    const sig = signUtmpayBody(SECRET, ts(), body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyUtmpaySignature({ secret: SECRET, timestamp: ts(), signature: sig, body, nowMs: NOW })).toEqual({ ok: true });
  });
  it("recusa corpo alterado, segredo errado e assinatura/cabeçalho ausente", () => {
    const sig = signUtmpayBody(SECRET, ts(), body);
    expect(verifyUtmpaySignature({ secret: SECRET, timestamp: ts(), signature: sig, body: body + " ", nowMs: NOW })).toEqual({ ok: false, reason: "signature" });
    expect(verifyUtmpaySignature({ secret: "outro", timestamp: ts(), signature: sig, body, nowMs: NOW })).toEqual({ ok: false, reason: "signature" });
    expect(verifyUtmpaySignature({ secret: SECRET, timestamp: ts(), signature: null, body, nowMs: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(verifyUtmpaySignature({ secret: SECRET, timestamp: null, signature: sig, body, nowMs: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(verifyUtmpaySignature({ secret: SECRET, timestamp: ts(), signature: "sha256=curta", body, nowMs: NOW }).ok).toBe(false);
  });
  it("relógio: dentro de 5 min passa; fora (passado ou futuro) ou timestamp inválido recusa", () => {
    for (const off of [-299, 299]) {
      const sig = signUtmpayBody(SECRET, ts(off), body);
      expect(verifyUtmpaySignature({ secret: SECRET, timestamp: ts(off), signature: sig, body, nowMs: NOW }).ok).toBe(true);
    }
    for (const off of [-301, 301, -3600]) {
      const sig = signUtmpayBody(SECRET, ts(off), body);
      expect(verifyUtmpaySignature({ secret: SECRET, timestamp: ts(off), signature: sig, body, nowMs: NOW })).toEqual({ ok: false, reason: "timestamp" });
    }
    expect(verifyUtmpaySignature({ secret: SECRET, timestamp: "abc", signature: "sha256=x", body, nowMs: NOW })).toEqual({ ok: false, reason: "timestamp" });
  });
});

describe("evento do UTMpay", () => {
  const ok = { event_id: "123e4567-e89b-42d3-a456-426614174000", tid: "t-1", etapa: "payment_start", occurred_at: "2026-10-14T12:00:00Z", codigo: "abc", campanha: "Setembro", canal: "whatsapp" };
  it("valida o contrato e normaliza", () => {
    const r = parseUtmpayEvent(JSON.stringify(ok));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event).toMatchObject({ eventId: ok.event_id, tid: "t-1", etapa: "payment_start", codigo: "abc", campanha: "Setembro", canal: "whatsapp" });
  });
  it.each([
    [{ ...ok, event_id: "nao-uuid" }],
    [{ ...ok, tid: "" }],
    [{ ...ok, tid: "x".repeat(41) }],
    [{ ...ok, etapa: "comprou" }],
    [{ ...ok, occurred_at: "ontem" }],
  ])("recusa corpo inválido %#", (body) => {
    expect(parseUtmpayEvent(JSON.stringify(body)).ok).toBe(false);
  });
  it("recusa JSON ruim e não-objeto; as 6 etapas valem", () => {
    expect(parseUtmpayEvent("lixo").ok).toBe(false);
    expect(parseUtmpayEvent("[]").ok).toBe(false);
    for (const etapa of ["click", "cpf_view", "cpf_submit", "payment_view", "payment_start", "paid"]) expect(parseUtmpayEvent(JSON.stringify({ ...ok, etapa })).ok).toBe(true);
  });
  it("peekTid acha o tid sem validar o resto", () => {
    expect(peekTid('{"tid":" abc "}')).toBe("abc");
    expect(peekTid("lixo")).toBeNull();
    expect(peekTid('{"tid":42}')).toBeNull();
  });
  it("janela de atribuição: até N dias depois do envio", () => {
    const sent = new Date("2026-10-01T00:00:00Z");
    expect(withinAttributionWindow(sent, new Date("2026-10-08T00:00:00Z"), 7)).toBe(true);
    expect(withinAttributionWindow(sent, new Date("2026-10-08T00:00:01Z"), 7)).toBe(false);
  });
});

describe("atribuição (conversa entre o envio e o evento)", () => {
  const from = new Date("2026-10-01T10:00:00Z");
  const to = new Date("2026-10-02T10:00:00Z");
  const m = (sender_type: string, origin: string | null, minutes: number, sender_id: string | null = null) => ({
    sender_type,
    origin,
    sender_id,
    created_at: new Date(from.getTime() + minutes * 60_000).toISOString(),
  });
  it("sem mensagem do contato ⇒ direto (a mensagem do próprio disparo não conta)", () => {
    expect(computeAttribution([m("agent", "campaign", 1)], from, to)).toEqual({ atribuicao: "direto", atendenteId: null });
    expect(computeAttribution([], from, to)).toEqual({ atribuicao: "direto", atendenteId: null });
  });
  it("só IA/fluxo respondeu ⇒ ia", () => {
    expect(computeAttribution([m("customer", "customer", 5), m("agent", "ai", 6, "ai-1")], from, to).atribuicao).toBe("ia");
    expect(computeAttribution([m("customer", "customer", 5), m("agent", "flow", 6)], from, to).atribuicao).toBe("ia");
    expect(computeAttribution([m("customer", "customer", 5), m("bot", null, 6)], from, to).atribuicao).toBe("ia");
  });
  it("humano vence IA e vale o ÚLTIMO atendente", () => {
    const r = computeAttribution(
      [m("customer", "customer", 5), m("agent", "ai", 6), m("agent", "operator", 7, "ana"), m("customer", "customer", 8), m("agent", "operator", 9, "bia"), m("agent", "ai", 10)],
      from,
      to,
    );
    expect(r).toEqual({ atribuicao: "humano", atendenteId: "bia" });
  });
  it("linha antiga sem origem de um atendente com id conta como humano", () => {
    expect(computeAttribution([m("customer", null, 5), m("agent", null, 6, "ana")], from, to)).toEqual({ atribuicao: "humano", atendenteId: "ana" });
  });
  it("o contato escreveu e ninguém respondeu ⇒ direto; fora do intervalo não conta", () => {
    expect(computeAttribution([m("customer", "customer", 5)], from, to).atribuicao).toBe("direto");
    expect(computeAttribution([m("customer", "customer", -5), m("agent", "operator", 60 * 30, "ana")], from, to).atribuicao).toBe("direto");
  });
});

describe("URL da mensagem", () => {
  it("acha a primeira URL, apara a pontuação final e troca preservando o resto do texto", () => {
    const text = "Olá! Negocie em https://exemplo.com/boleto?x=1. Qualquer dúvida, responda. Veja também https://outra.com";
    const f = findFirstUrl(text)!;
    expect(f.url).toBe("https://exemplo.com/boleto?x=1");
    expect(replaceFoundUrl(text, f, "https://utm.pay/s/abc")).toBe("Olá! Negocie em https://utm.pay/s/abc. Qualquer dúvida, responda. Veja também https://outra.com");
  });
  it("sem URL ou com esquema perigoso: null", () => {
    expect(findFirstUrl("sem link")).toBeNull();
    expect(findFirstUrl("javascript:alert(1)")).toBeNull();
  });
  it("em variáveis do template: primeira variável com URL; markdown [texto](url) troca só a URL", () => {
    const hit = findFirstUrlInVariables(["Maria", "[Pague aqui](https://exemplo.com/p)", "https://x.com"])!;
    expect(hit.index).toBe(1);
    expect(replaceFoundUrl("[Pague aqui](https://exemplo.com/p)", hit.found, "https://utm.pay/s/z")).toBe("[Pague aqui](https://utm.pay/s/z)");
    expect(findFirstUrlInVariables(["a", "b"])).toBeNull();
  });
});

describe("configuração (corpo do PUT e visão do GET)", () => {
  it("base_url: https, só origem", () => {
    expect(normalizeUtmpayBaseUrl("https://UTMPay.exemplo.com/")).toBe("https://utmpay.exemplo.com");
    for (const bad of ["http://x.com", "https://x.com/api", "https://x.com?a=1", "https://u:p@x.com", "x.com", "", 5]) expect(normalizeUtmpayBaseUrl(bad)).toBeNull();
  });
  it("1ª gravação exige base_url; padrões: ligado, janela 7, sem enviar sem rastreio", () => {
    expect(validateUtmpayConfigBody({}, null)).toMatchObject({ ok: false });
    const ok = validateUtmpayConfigBody({ base_url: "https://utmpay.exemplo.com", api_key: "k" }, null);
    expect(ok).toMatchObject({ ok: true, value: { enabled: true, janela_dias: 7, send_without_tracking: false, base_url: "https://utmpay.exemplo.com" } });
  });
  it("PUT parcial mantém o que não veio; valida tipos e a janela 1–90", () => {
    const current = { enabled: true, base_url: "https://a.com", api_key_enc: "x", webhook_secret_enc: "y", janela_dias: 14, send_without_tracking: true };
    expect(validateUtmpayConfigBody({ enabled: false }, current)).toMatchObject({ ok: true, value: { enabled: false, base_url: "https://a.com", janela_dias: 14, send_without_tracking: true } });
    for (const bad of [{ janela_dias: 0 }, { janela_dias: 91 }, { janela_dias: 1.5 }, { enabled: "sim" }, { send_without_tracking: 1 }, { base_url: "http://x" }]) {
      expect(validateUtmpayConfigBody(bad, current).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateUtmpayConfigBody("texto", current).ok).toBe(false);
  });
  it("a visão NUNCA traz segredo: só has_*", () => {
    const v = viewUtmpayConfig({ enabled: true, base_url: "https://a.com", api_key_enc: "CIFRADO", webhook_secret_enc: null, janela_dias: 7, send_without_tracking: false }, true, "https://app.com/api/integrations/utmpay/events");
    expect(v).toMatchObject({ configured: true, has_api_key: true, has_webhook_secret: false });
    expect(JSON.stringify(v)).not.toContain("CIFRADO");
    expect(viewUtmpayConfig(null, true, null)).toMatchObject({ configured: false, enabled: false, janela_dias: 7 });
  });
  it("events_url vem do NEXT_PUBLIC_APP_URL (https)", () => {
    expect(utmpayEventsUrl({ NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com/x" } as never)).toBe("https://crm.exemplo.com/api/integrations/utmpay/events");
    expect(utmpayEventsUrl({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" } as never)).toBeNull();
    expect(utmpayEventsUrl({} as never)).toBeNull();
  });
});

describe("cliente: resposta do lote e aluno", () => {
  it("aceita link_curto ou short_url, ignora itens sem link/tid e links não-http", () => {
    expect(
      parseBatchResponse({ links: [{ tid: "a", link_curto: "https://u/s/1", codigo: "1" }, { tid: "b", short_url: "https://u/s/2" }, { tid: "c" }, { link_curto: "https://u/s/3" }, { tid: "d", link_curto: "javascript:x" }] }),
    ).toEqual([{ tid: "a", linkCurto: "https://u/s/1", codigo: "1" }, { tid: "b", linkCurto: "https://u/s/2", codigo: null }]);
    expect(() => parseBatchResponse({})).toThrow();
  });
  it("aluno_id: CPF do contato; sem CPF, uma chave do próprio contato (nunca telefone)", () => {
    expect(cpfDigits("123.456.789-09")).toBe("12345678909");
    expect(cpfDigits("123")).toBeNull();
    expect(alunoIdFor("12345678909", "c1", "t1")).toBe("12345678909");
    expect(alunoIdFor(null, "c1", "t1")).toBe("crm-c1");
    expect(alunoIdFor(null, null, "t1")).toBe("crm-t1");
  });
});

describe("funil: taxas e selo", () => {
  it("taxa = contagem ÷ entregues; o denominador nunca fica abaixo da contagem; null sem entregues", () => {
    expect(rate(50, 200)).toBe(0.25);
    expect(rate(30, 10)).toBe(1);
    expect(rate(0, 0)).toBeNull();
  });
  it("monta a visão com atribuição completa (zeros) e nomes dos atendentes", () => {
    const v = buildFunnelView({
      available: true,
      tracking: true,
      delivered: 100,
      stats: { links: 120, clicou: 40, fechou: 10, pagou: 5, por_atribuicao: { fechou: { ia: 4 }, pagou: { humano: 5 } }, por_atendente: [{ atendente_id: "u1", fechou: 3, pagou: 5 }] },
      names: new Map([["u1", "Ana"]]),
    });
    expect(v).toMatchObject({ entregues: 100, links: 120, clicou: 40, taxas: { clicou: 0.4, fechou: 0.1, pagou: 0.05 } });
    expect(v.por_atribuicao.fechou).toEqual({ direto: 0, ia: 4, humano: 0 });
    expect(v.por_atendente).toEqual([{ atendente_id: "u1", atendente_nome: "Ana", fechou: 3, pagou: 5 }]);
  });
  it("selo: valor numérico, atribuição só nos valores do contrato", () => {
    const b = toBadge({ tid: "t", campaign_id: null, created_at: "2026-10-01T00:00:00Z", clicou_em: null, fechou_em: null, pagou_em: null, atribuicao: "xyz", atendente_id: null, situacao_acordo: "Em aberto", valor_em_aberto: "1234.50", instituicao: "X", verificado_em: null }, "Camp", null);
    expect(b).toMatchObject({ campanha: "Camp", atribuicao: null, valor_em_aberto: 1234.5, situacao_acordo: "Em aberto" });
  });
});
