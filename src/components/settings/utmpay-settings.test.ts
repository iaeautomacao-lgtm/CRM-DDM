import { describe, expect, it } from "vitest";

import { MIN_SEGREDO, buildInput, generateSecret } from "./utmpay-settings";
import type { UtmpayConfig } from "@/lib/utmpay/api-client";

const saved: UtmpayConfig = { available: true, configured: true, enabled: false, base_url: "", has_api_key: false, has_webhook_secret: false, janela_dias: 7, send_without_tracking: false, events_url: "", atualizado_em: null, checklist: null };
const form = { enabled: false, base_url: "", api_key: "", webhook_secret: "", janela_dias: "7", send_without_tracking: false };
const SEGREDO = "um-segredo-bem-longo-123";

describe("UTMpay · formulário de configuração", () => {
  it("chave e segredo vazios ficam fora do PUT (o servidor mantém o atual)", () => {
    const { input, error } = buildInput({ ...form, base_url: "https://u.example.com/" }, { ...saved, has_api_key: true, has_webhook_secret: true });
    expect(error).toBeNull();
    expect(input).toEqual({ enabled: false, base_url: "https://u.example.com", janela_dias: 7, send_without_tracking: false });
  });
  it("valor novo de chave/segredo vai no PUT", () => {
    const { input, error } = buildInput({ ...form, base_url: "https://u.example.com", api_key: " k ", webhook_secret: SEGREDO }, saved);
    expect(error).toBeNull();
    expect(input.api_key).toBe("k");
    expect(input.webhook_secret).toBe(SEGREDO);
  });
  it("segredo dos avisos curto é recusado com o que fazer (mínimo do UTMpay: 16)", () => {
    const { error } = buildInput({ ...form, base_url: "https://u.example.com", webhook_secret: "curto" }, saved);
    expect(MIN_SEGREDO).toBe(16);
    expect(error).toMatch(/pelo menos 16/);
    expect(error).toMatch(/Gerar um segredo/);
  });
  it("valida janela (1–90), https sem caminho e o que falta para ligar — sempre dizendo o que fazer", () => {
    expect(buildInput({ ...form, janela_dias: "0" }, saved).error).toMatch(/1 a 90/);
    expect(buildInput({ ...form, janela_dias: "91" }, saved).error).toMatch(/1 a 90/);
    expect(buildInput({ ...form, base_url: "http://u.example.com" }, saved).error).toMatch(/https/);
    expect(buildInput({ ...form, base_url: "https://u.example.com/rota" }, saved).error).toMatch(/sem caminho/);
    expect(buildInput({ ...form, enabled: true }, saved).error).toMatch(/endereço/);
    expect(buildInput({ ...form, enabled: true, base_url: "https://u.example.com" }, saved).error).toMatch(/chave de acesso/);
    expect(buildInput({ ...form, enabled: true, base_url: "https://u.example.com", api_key: "k" }, saved).error).toMatch(/segredo dos avisos/);
    expect(buildInput({ ...form, enabled: true, base_url: "https://u.example.com", api_key: "k", webhook_secret: SEGREDO }, saved).error).toBeNull();
  });
  it("sem jargão nas mensagens de erro", () => {
    const msgs = [
      buildInput({ ...form, enabled: true }, saved).error,
      buildInput({ ...form, enabled: true, base_url: "https://u.example.com" }, saved).error,
      buildInput({ ...form, enabled: true, base_url: "https://u.example.com", api_key: "k" }, saved).error,
    ].join(" ");
    expect(msgs).not.toMatch(/webhook|HMAC|X-API-Key|outbox|tid\b/i);
  });
});

describe("UTMpay · segredo gerado", () => {
  it("tem 32 caracteres, só letras e números, e muda a cada vez", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(a.length).toBeGreaterThanOrEqual(MIN_SEGREDO);
    expect(a).not.toBe(b);
  });
});
