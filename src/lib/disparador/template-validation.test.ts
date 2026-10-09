import { describe, expect, it } from "vitest";
import {
  countBodyVariables,
  templateComponentProblem,
  templateRowsForWaba,
  validateCampaignTemplate,
  type LocalTemplateRow,
} from "./template-validation";

const base: LocalTemplateRow = {
  name: "cobranca_1",
  language: "pt_BR",
  status: "APPROVED",
  waba_id: "waba-a",
  body_text: "Olá {{1}}, seu débito é {{2}}.",
  header_type: null,
  header_content: null,
  buttons: null,
};

const input = (rows: LocalTemplateRow[], extra: Partial<Parameters<typeof validateCampaignTemplate>[0]> = {}) =>
  validateCampaignTemplate({ templateName: "cobranca_1", language: "pt_BR", mappedVariables: 2, rows, ...extra });

describe("countBodyVariables", () => {
  it("maior {{n}}, tolerando espaços", () => {
    expect(countBodyVariables("Oi {{1}} {{ 3 }} {{1}}")).toBe(3);
    expect(countBodyVariables("sem variável")).toBe(0);
    expect(countBodyVariables(null)).toBe(0);
  });
});

describe("templateComponentProblem", () => {
  it("cabeçalho de mídia", () => {
    expect(templateComponentProblem({ ...base, header_type: "image" })).toMatch(/cabeçalho de imagem/);
    expect(templateComponentProblem({ ...base, header_type: "document" })).toMatch(/documento/);
  });
  it("cabeçalho de texto: fixo ok, com variável não", () => {
    expect(templateComponentProblem({ ...base, header_type: "text", header_content: "Aviso" })).toBeNull();
    expect(templateComponentProblem({ ...base, header_type: "text", header_content: "Oi {{1}}" })).toMatch(/cabeçalho/);
  });
  it("botão de URL dinâmica e copiar código; URL fixa e resposta rápida ok", () => {
    expect(
      templateComponentProblem({ ...base, buttons: [{ type: "URL", url: "https://x.com/{{1}}" }] })
    ).toMatch(/link dinâmico/);
    expect(templateComponentProblem({ ...base, buttons: [{ type: "COPY_CODE" }] })).toMatch(/copiar código/);
    // botão FLOW (PRD 21.3): o disparador manda o flow_token de cada envio, então o template é compatível
    expect(templateComponentProblem({ ...base, buttons: [{ type: "FLOW" }] })).toBeNull();
    expect(
      templateComponentProblem({
        ...base,
        buttons: [{ type: "URL", url: "https://x.com/pagar" }, { type: "QUICK_REPLY" }],
      })
    ).toBeNull();
  });
});

describe("validateCampaignTemplate", () => {
  it("template aprovado e compatível passa", () => {
    expect(input([base])).toEqual({ ok: true });
  });

  it("fora do catálogo local: bloqueia pedindo sincronização", () => {
    for (const r of [input([]), input([{ ...base, language: "en_US" }])]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/não encontrado no catálogo deste número — sincronize os templates/);
    }
  });

  it("não aprovado falha com o status em pt-BR", () => {
    const r = input([{ ...base, status: "PAUSED" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/não está aprovado.*pausado/);
  });

  it("mais variáveis no corpo do que mapeadas falha", () => {
    const r = input([{ ...base, body_text: "{{1}} {{2}} {{3}}" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/3 variáveis.*só 2/);
    expect(input([{ ...base, body_text: "{{1}}" }]).ok).toBe(true); // menos é ok
  });

  it("componente não suportado falha mesmo aprovado", () => {
    const r = input([{ ...base, header_type: "video" }]);
    expect(r.ok).toBe(false);
  });

  it("multi-WABA: cada conta usada precisa do template aprovado", () => {
    const rows = [base, { ...base, waba_id: "waba-b", status: "REJECTED" }];
    expect(input(rows, { wabaIds: ["waba-a"] }).ok).toBe(true);
    const r = input(rows, { wabaIds: ["waba-a", "waba-b"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/waba-b.*rejeitado/);
  });

  it("linha sem waba_id não autoriza campanha quando a WABA é conhecida", () => {
    const r = input([{ ...base, waba_id: null }], { wabaIds: ["waba-x"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/não encontrado no catálogo deste número/);
  });

  it("WABA sem linha local bloqueia (template de outro número)", () => {
    const r = input([base], { wabaIds: ["waba-z"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sincronize os templates/);
  });

  it("linha da WABA REJEITADA + antiga APROVADA: bloqueia (a linha da WABA decide)", () => {
    const rows = [{ ...base, status: "REJECTED" }, { ...base, waba_id: null }];
    const r = input(rows, { wabaIds: ["waba-a"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rejeitado/);
  });

  it("componentes vêm da linha da WABA, não da antiga", () => {
    const rows = [{ ...base, header_type: "image" }, { ...base, waba_id: null }];
    expect(input(rows, { wabaIds: ["waba-a"] }).ok).toBe(false);
    // Antiga com mídia não atrapalha quando a da WABA é compatível.
    expect(input([base, { ...base, waba_id: null, header_type: "image" }], { wabaIds: ["waba-a"] })).toEqual({ ok: true });
  });

  it("WABA diferente não herda linha legada", () => {
    const rows = [{ ...base, status: "REJECTED" }, { ...base, waba_id: null }];
    const r = input(rows, { wabaIds: ["waba-b"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/não encontrado no catálogo deste número/);
  });
});

describe("templateRowsForWaba", () => {
  const rows = [
    { name: "t", language: "pt_BR", waba_id: "a", tag: "a-pt" },
    { name: "t", language: "pt_BR", waba_id: null, tag: "legacy-pt" },
    { name: "t", language: "en_US", waba_id: null, tag: "legacy-en" },
    { name: "t", language: "pt_BR", waba_id: "b", tag: "b-pt" },
  ];
  it("por idioma: a da WABA substitui a antiga; antiga sem par continua; outras WABAs saem", () => {
    expect(templateRowsForWaba(rows, "a").map((r) => r.tag)).toEqual(["a-pt", "legacy-en"]);
    expect(templateRowsForWaba(rows, "c").map((r) => r.tag)).toEqual(["legacy-pt", "legacy-en"]);
  });
  it("sem WABA conhecida: tudo", () => {
    expect(templateRowsForWaba(rows, null)).toHaveLength(4);
  });
});
