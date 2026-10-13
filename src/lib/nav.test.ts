import { describe, expect, it } from "vitest";
import { NAV_GROUPS, bottomNavItems, getBreadcrumbs, getPageTitle, navItems, reportNavItems } from "./nav";

describe("getBreadcrumbs", () => {
  it("tem um item só nas telas de um nível", () => {
    expect(getBreadcrumbs("/flows")).toEqual([{ label: "Fluxos" }]);
    expect(getBreadcrumbs("/monitoramento")).toEqual([{ label: "Monitoramento" }]);
  });

  it("monta a trilha de Fluxos com link para o fluxo", () => {
    expect(getBreadcrumbs("/flows/abc")).toEqual([{ label: "Fluxos", href: "/flows" }, { label: "Editor de fluxo" }]);
    expect(getBreadcrumbs("/flows/abc/runs")).toEqual([
      { label: "Fluxos", href: "/flows" },
      { label: "Fluxo", href: "/flows/abc" },
      { label: "Execuções" },
    ]);
  });

  it("monta a trilha de Automações", () => {
    expect(getBreadcrumbs("/automations/new")[1]).toEqual({ label: "Nova automação" });
    expect(getBreadcrumbs("/automations/x1/edit")[1]).toEqual({ label: "Editar automação" });
    expect(getBreadcrumbs("/automations/x1/logs")[1]).toEqual({ label: "Logs de execução" });
  });

  it("cobre detalhes de equipe, contato, campanha e chaves do Intelligence", () => {
    expect(getBreadcrumbs("/equipes/t1").map((c) => c.label)).toEqual(["Equipes", "Equipe"]);
    expect(getBreadcrumbs("/contacts/c1").map((c) => c.label)).toEqual(["Contatos", "Contato"]);
    expect(getBreadcrumbs("/disparador/campanhas/k1").map((c) => c.label)).toEqual(["Campanhas", "Campanha"]);
    expect(getBreadcrumbs("/inteligencia/chaves").map((c) => c.label)).toEqual(["Inteligência", "Chave pessoal do MCP"]);
  });

  it("ignora a barra final e a query", () => {
    expect(getBreadcrumbs("/flows/abc/runs/?run_id=1")).toHaveLength(3);
  });
});

describe("getPageTitle", () => {
  it("une a trilha com ponto médio e mantém o título simples nas demais", () => {
    expect(getPageTitle("/flows/abc/runs")).toBe("Fluxos · Fluxo · Execuções");
    expect(getPageTitle("/automations/new")).toBe("Automações · Nova automação");
    expect(getPageTitle("/dashboard")).toBe("Painel");
  });

  it("nunca devolve vazio", () => {
    expect(getPageTitle("/rota-desconhecida")).toBe("Rota desconhecida");
    expect(getPageTitle("/")).toBe("OmniDDM");
  });
});

describe("menu (decisão do dono, 13/10)", () => {
  it("tem os sete grupos da arquitetura final, na ordem", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      "Visão geral",
      "Atendimento",
      "Clientes",
      "Campanhas",
      "Automação e IA",
      "Relatórios",
      "Administração",
    ]);
    for (const item of navItems) expect(NAV_GROUPS.map((g) => g.id)).toContain(item.group);
  });

  it("Canais e Auditoria ficam em Administração; Logs do sistema não entra no menu", () => {
    const group = (href: string) => navItems.find((i) => i.href === href)?.group;
    expect(group("/canais")).toBe("administration");
    expect(group("/relatorios/auditoria")).toBe("administration");
    expect(navItems.some((i) => i.href === "/ddm-logs")).toBe(false);
    expect(reportNavItems.some((i) => i.href === "/relatorios/auditoria")).toBe(false);
  });

  it("usa Campanhas, Painel, Atendentes e nunca Disparador nos rótulos", () => {
    const labels = [...navItems, ...reportNavItems, ...bottomNavItems].map((i) => i.label);
    expect(labels).toContain("Campanhas");
    expect(labels).toContain("Painel");
    expect(labels.some((l) => /disparador|envio em lote|dashboard/i.test(l))).toBe(false);
    expect(getPageTitle("/disparador/monitor")).toBe("Campanhas · Monitor de envios");
    expect(getPageTitle("/relatorios/agentes")).toBe("Relatórios · Sessões de atendentes");
    expect(getPageTitle("/relatorios/atendimentos")).toBe("Relatórios · Desempenho do atendimento");
  });
});
