import { describe, expect, it } from "vitest";
import { canAccessRoute, getDefaultRoute, isRouteGated } from "./role-utils";

describe("supervisor (migrations 139/140)", () => {
  it("acessa Inbox, Monitoramento e Dashboard", () => {
    for (const path of ["/inbox", "/monitoramento", "/dashboard"]) {
      expect(canAccessRoute("supervisor", path)).toBe(true);
    }
  });
  it("não acessa configuração nem ferramentas de admin", () => {
    for (const path of ["/settings", "/usuarios", "/canais", "/flows", "/disparador", "/equipes", "/relatorios/envio-em-lote", "/relatorios/exportacoes", "/relatorios/auditoria"]) {
      expect(canAccessRoute("supervisor", path)).toBe(false);
    }
  });
  it("vê os relatórios de atendimento (escopados pela 143)", () => {
    for (const path of ["/relatorios/atendimentos", "/relatorios/conversas", "/relatorios/agentes", "/relatorios/tabulacoes"]) {
      expect(canAccessRoute("supervisor", path)).toBe(true);
    }
    expect(canAccessRoute("agent", "/relatorios/atendimentos")).toBe(false);
  });
  it("DDM Intelligence (/inteligencia): supervisor ou acima", () => {
    for (const role of ["owner", "admin", "supervisor"] as const) {
      expect(canAccessRoute(role, "/inteligencia")).toBe(true);
    }
    expect(canAccessRoute("agent", "/inteligencia")).toBe(false);
    expect(canAccessRoute("viewer", "/inteligencia")).toBe(false);
    expect(isRouteGated("/inteligencia")).toBe(true);
  });
  it("cai no Monitoramento depois do login", () => {
    expect(getDefaultRoute("supervisor")).toBe("/monitoramento");
    expect(getDefaultRoute("agent")).toBe("/inbox");
    expect(getDefaultRoute("admin")).toBe("/dashboard");
  });
});
