import { describe, expect, it } from "vitest";
import { canAccessRoute, getDefaultRoute, isRouteGated } from "./role-utils";

describe("supervisor (migrations 139/140)", () => {
  it("acessa Inbox, Monitoramento e Dashboard", () => {
    for (const path of ["/inbox", "/monitoramento", "/dashboard"]) {
      expect(canAccessRoute("supervisor", path)).toBe(true);
    }
  });
  it("não acessa configuração nem ferramentas de admin", () => {
    for (const path of ["/usuarios", "/canais", "/flows", "/disparador", "/equipes", "/relatorios/envio-em-lote", "/relatorios/exportacoes", "/relatorios/auditoria"]) {
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

describe("acesso por papel (decisões do dono de 13/10)", () => {
  it("Canais, Contatos, Funis, Ajuda e Extrator de leads: proprietário e admin", () => {
    for (const path of ["/canais", "/contacts", "/pipelines", "/ajuda", "/lead-extractor"]) {
      expect(canAccessRoute("owner", path), path).toBe(true);
      expect(canAccessRoute("admin", path), path).toBe(true);
      for (const role of ["supervisor", "agent", "viewer"] as const) expect(canAccessRoute(role, path), `${role} ${path}`).toBe(false);
    }
  });
  it("Configurações abre para o supervisor (as abas filtram); operador e visualizador não", () => {
    expect(canAccessRoute("supervisor", "/settings")).toBe(true);
    expect(canAccessRoute("agent", "/settings")).toBe(false);
    expect(canAccessRoute("viewer", "/settings")).toBe(false);
  });
  it("Histórico: quem atende conversas; Perfil: todos", () => {
    for (const role of ["owner", "admin", "supervisor", "agent"] as const) expect(canAccessRoute(role, "/historico")).toBe(true);
    expect(canAccessRoute("viewer", "/historico")).toBe(false);
    for (const role of ["owner", "admin", "supervisor", "agent", "viewer"] as const) expect(canAccessRoute(role, "/perfil")).toBe(true);
  });
});
