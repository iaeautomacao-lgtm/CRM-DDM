import { describe, expect, it } from "vitest";
import {
  countBodyVariables,
  templateComponentProblem,
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

  it("linha sem waba_id (antes da 073) vale para qualquer WABA", () => {
    expect(input([{ ...base, waba_id: null }], { wabaIds: ["waba-x"] })).toEqual({ ok: true });
  });

  it("WABA sem linha local bloqueia (template de outro número)", () => {
    const r = input([base], { wabaIds: ["waba-z"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sincronize os templates/);
  });
});
