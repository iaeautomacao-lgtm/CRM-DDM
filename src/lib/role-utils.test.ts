import { describe, expect, it } from "vitest";
import { canAccessRoute, getDefaultRoute } from "./role-utils";

describe("supervisor (migrations 134/135)", () => {
  it("acessa Inbox, Monitoramento, Relatórios e Dashboard", () => {
    for (const path of ["/inbox", "/monitoramento", "/relatorios/atendimentos", "/dashboard"]) {
      expect(canAccessRoute("supervisor", path)).toBe(true);
    }
  });
  it("não acessa configuração nem ferramentas de admin", () => {
    for (const path of ["/settings", "/usuarios", "/canais", "/flows", "/disparador", "/equipes"]) {
      expect(canAccessRoute("supervisor", path)).toBe(false);
    }
  });
  it("cai no Monitoramento depois do login", () => {
    expect(getDefaultRoute("supervisor")).toBe("/monitoramento");
    expect(getDefaultRoute("agent")).toBe("/inbox");
    expect(getDefaultRoute("admin")).toBe("/dashboard");
  });
});
