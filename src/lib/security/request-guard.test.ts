import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { isCrossSiteMutation, isPublicPage } from "./request-guard";

const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://app.test${path}`, { method: init.method ?? "POST", headers: init.headers });

describe("isPublicPage", () => {
  it.each(["/", "/login", "/login/2fa", "/signup", "/forgot-password", "/reset-password", "/auth/callback", "/join/abc", "/docs", "/docs/api", "/unauthorized", "/w/token123", "/brand/logo.svg"])(
    "%s é pública",
    (p) => expect(isPublicPage(p)).toBe(true),
  );

  it.each(["/dashboard", "/inbox", "/contacts", "/disparador/campanhas", "/relatorios", "/membros", "/seguranca", "/ddm-logs", "/uma-tela-nova", "/loginx", "/docsx", "/wiki", "/authx"])(
    "%s é protegida (tudo que não está na lista pública)",
    (p) => expect(isPublicPage(p)).toBe(false),
  );
});

describe("isCrossSiteMutation", () => {
  it("só olha /api/* com método que escreve", () => {
    expect(isCrossSiteMutation(req("/dashboard", { headers: { "sec-fetch-site": "cross-site" } }))).toBe(false);
    expect(isCrossSiteMutation(req("/api/contacts", { method: "GET", headers: { "sec-fetch-site": "cross-site" } }))).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isCrossSiteMutation(req("/api/contacts", { method, headers: { "sec-fetch-site": "cross-site" } })), method).toBe(true);
    }
  });

  it("Sec-Fetch-Site: same-origin e none passam; cross-site e same-site são barrados", () => {
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { "sec-fetch-site": "same-origin" } }))).toBe(false);
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { "sec-fetch-site": "none" } }))).toBe(false);
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { "sec-fetch-site": "cross-site" } }))).toBe(true);
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { "sec-fetch-site": "same-site" } }))).toBe(true);
  });

  it("sem Sec-Fetch-Site, o Origin decide (host igual passa; outro host, 'null' e lixo são barrados)", () => {
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { origin: "https://app.test" } }))).toBe(false);
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { origin: "https://evil.example" } }))).toBe(true);
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { origin: "null" } }))).toBe(true);
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { origin: "https://app.test.evil.example" } }))).toBe(true);
  });

  it("atrás de proxy: o X-Forwarded-Host também vale como host próprio", () => {
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { origin: "https://crm.cliente.com", "x-forwarded-host": "crm.cliente.com" } }))).toBe(false);
  });

  it("sem Sec-Fetch-Site e sem Origin não é navegador (curl, cron, servidor): passa", () => {
    expect(isCrossSiteMutation(req("/api/contacts"))).toBe(false);
  });

  it("com Authorization (Bearer) não checa: a credencial vem no cabeçalho, não no cookie", () => {
    expect(isCrossSiteMutation(req("/api/contacts", { headers: { authorization: "Bearer x", "sec-fetch-site": "cross-site" } }))).toBe(false);
  });

  it.each([
    "/api/whatsapp/webhook",
    "/api/whatsapp/webhook/waha",
    "/api/meta/webhook",
    "/api/disparador/cron",
    "/api/flows/cron",
    "/api/webchat/tok/messages",
    "/api/v1/whatsapp/send",
    "/api/mcp",
    "/api/stress/run",
  ])("%s fica fora da checagem (webhook, cron, webchat público, API com chave, MCP)", (p) => {
    expect(isCrossSiteMutation(req(p, { headers: { "sec-fetch-site": "cross-site", origin: "https://outro.site" } }))).toBe(false);
  });
});
