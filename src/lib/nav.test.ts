import { describe, expect, it } from "vitest";
import { getBreadcrumbs, getPageTitle } from "./nav";

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
    expect(getBreadcrumbs("/disparador/campanhas/k1").map((c) => c.label)).toEqual(["Disparador · Campanhas", "Campanha"]);
    expect(getBreadcrumbs("/inteligencia/chaves").map((c) => c.label)).toEqual(["Inteligência", "Chaves"]);
  });

  it("ignora a barra final e a query", () => {
    expect(getBreadcrumbs("/flows/abc/runs/?run_id=1")).toHaveLength(3);
  });
});

describe("getPageTitle", () => {
  it("une a trilha com ponto médio e mantém o título simples nas demais", () => {
    expect(getPageTitle("/flows/abc/runs")).toBe("Fluxos · Fluxo · Execuções");
    expect(getPageTitle("/automations/new")).toBe("Automações · Nova automação");
    expect(getPageTitle("/dashboard")).toBe("Dashboard");
  });

  it("nunca devolve vazio", () => {
    expect(getPageTitle("/rota-desconhecida")).toBe("Rota desconhecida");
    expect(getPageTitle("/")).toBe("OmniDDM");
  });
});
