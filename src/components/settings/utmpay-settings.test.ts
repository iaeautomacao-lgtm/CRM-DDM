import { describe, expect, it } from "vitest";

import { buildInput } from "./utmpay-settings";
import type { UtmpayConfig } from "@/lib/utmpay/client";

const saved: UtmpayConfig = { available: true, configured: true, enabled: false, base_url: "", has_api_key: false, has_webhook_secret: false, janela_dias: 7, send_without_tracking: false, events_url: "" };
const form = { enabled: false, base_url: "", api_key: "", webhook_secret: "", janela_dias: "7", send_without_tracking: false };

describe("UTMpay · formulário de configuração", () => {
  it("chave e segredo vazios ficam fora do PUT (o servidor mantém o atual)", () => {
    const { input, error } = buildInput({ ...form, base_url: "https://u.example.com/" }, { ...saved, has_api_key: true, has_webhook_secret: true });
    expect(error).toBeNull();
    expect(input).toEqual({ enabled: false, base_url: "https://u.example.com", janela_dias: 7, send_without_tracking: false });
  });
  it("valor novo de chave/segredo vai no PUT", () => {
    const { input } = buildInput({ ...form, base_url: "https://u.example.com", api_key: " k ", webhook_secret: "s" }, saved);
    expect(input.api_key).toBe("k");
    expect(input.webhook_secret).toBe("s");
  });
  it("valida janela (1–90), https sem caminho e o que falta para ligar", () => {
    expect(buildInput({ ...form, janela_dias: "0" }, saved).error).toMatch(/1 a 90/);
    expect(buildInput({ ...form, janela_dias: "91" }, saved).error).toMatch(/1 a 90/);
    expect(buildInput({ ...form, base_url: "http://u.example.com" }, saved).error).toMatch(/https/);
    expect(buildInput({ ...form, base_url: "https://u.example.com/rota" }, saved).error).toMatch(/sem caminho/);
    expect(buildInput({ ...form, enabled: true }, saved).error).toMatch(/endereço/);
    expect(buildInput({ ...form, enabled: true, base_url: "https://u.example.com" }, saved).error).toMatch(/chave/);
    expect(buildInput({ ...form, enabled: true, base_url: "https://u.example.com", api_key: "k" }, saved).error).toMatch(/segredo/);
    expect(buildInput({ ...form, enabled: true, base_url: "https://u.example.com", api_key: "k", webhook_secret: "s" }, saved).error).toBeNull();
  });
});
