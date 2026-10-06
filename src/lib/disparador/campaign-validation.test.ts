import { describe, expect, it } from "vitest";
import {
  campaignChannelGroupKey,
  campaignTemplateNames,
  formatStartFailureReason,
  stripMessageTemplate,
  validateCampaignChannels,
  validateCampaignConfig,
  validateCampaignMessages,
  type CampaignChannel,
} from "./campaign-validation";
import type { LocalTemplateRow } from "./template-validation";

const metaA1: CampaignChannel = { id: "a1", provider: "meta", waba_id: "waba-a", habilitado: true, label: "Meta A1" };
const metaA2: CampaignChannel = { id: "a2", provider: "meta", waba_id: "waba-a", habilitado: true, label: "Meta A2" };
const metaB: CampaignChannel = { id: "b1", provider: "meta", waba_id: "waba-b", habilitado: true, label: "Meta B" };
const metaSemWaba: CampaignChannel = { id: "x1", provider: "meta", waba_id: null, habilitado: true, label: "Meta X" };
const waha1: CampaignChannel = { id: "w1", provider: "waha", habilitado: true, label: "WAHA 1" };
const waha2: CampaignChannel = { id: "w2", provider: "waha", label: "WAHA 2" };
const wahaOff: CampaignChannel = { id: "w3", provider: "waha", habilitado: false, label: "WAHA off" };
const all = [metaA1, metaA2, metaB, metaSemWaba, waha1, waha2, wahaOff];

const row: LocalTemplateRow = {
  name: "cobranca_1",
  language: "pt_BR",
  status: "APPROVED",
  waba_id: "waba-a",
  body_text: "Olá {{1}}, seu débito é {{2}}.",
};

const tplMsg = {
  tipo: "texto",
  conteudo: "Olá {{1}}, seu débito é {{2}}.",
  template_name: "cobranca_1",
  template_language: "pt_BR",
  template_variable_map: [{ type: "contact_field", field: "name" }, { type: "csv_var", index: 0 }],
};

describe("validateCampaignChannels", () => {
  it("exige ao menos um canal", () => {
    const r = validateCampaignChannels([], all);
    expect(r.ok).toBe(false);
  });

  it("Meta: vários números da mesma WABA = ok, devolve a WABA", () => {
    expect(validateCampaignChannels(["a1", "a2"], all)).toEqual({ ok: true, provider: "meta", wabaId: "waba-a" });
  });

  it("Meta: WABAs diferentes são bloqueadas", () => {
    const r = validateCampaignChannels(["a1", "b1"], all);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/WABA\) diferentes/);
  });

  it("Meta: número sem waba_id não pode ser usado", () => {
    const r = validateCampaignChannels(["x1"], all);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Meta X.*não tem WABA/);
  });

  it("Meta + WAHA na mesma campanha é bloqueado", () => {
    const r = validateCampaignChannels(["a1", "w1"], all);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/misturar canais oficiais \(Meta\) e WAHA/);
  });

  it("WAHA: ok (habilitado undefined conta como habilitado)", () => {
    expect(validateCampaignChannels(["w1", "w2"], all)).toEqual({ ok: true, provider: "waha", wabaId: null });
  });

  it("canal desabilitado é erro", () => {
    const r = validateCampaignChannels(["w1", "w3"], all);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/WAHA off está desabilitado/);
  });

  it("canal fora da conta / removido é erro", () => {
    const r = validateCampaignChannels(["w1", "outra-conta"], all);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/não pertence a esta conta/);
  });
});

describe("campaignChannelGroupKey", () => {
  it("mesmo grupo dentro da WABA; muda com provider ou WABA", () => {
    expect(campaignChannelGroupKey(["a1"], all)).toBe("meta:waba-a");
    expect(campaignChannelGroupKey(["a1", "a2"], all)).toBe("meta:waba-a");
    expect(campaignChannelGroupKey(["b1"], all)).toBe("meta:waba-b");
    expect(campaignChannelGroupKey(["w1"], all)).toBe("waha");
    expect(campaignChannelGroupKey([], all)).toBeNull();
    expect(campaignChannelGroupKey(["a1", "w1"], all)).toBeNull();
    expect(campaignChannelGroupKey(["a1", "b1"], all)).toBeNull();
  });
});

describe("validateCampaignMessages", () => {
  it("Meta: template aprovado do catálogo da WABA passa", () => {
    expect(validateCampaignMessages([tplMsg], "meta", { wabaId: "waba-a", templateRows: [row] })).toEqual([]);
  });

  it("Meta: texto livre (sem template) é bloqueado", () => {
    const errors = validateCampaignMessages([{ tipo: "texto", conteudo: "Oi" }], "meta", { wabaId: "waba-a" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Mensagem #1: .*template aprovado/);
  });

  it("Meta: IA/imagem/áudio/ligação são bloqueados", () => {
    for (const tipo of ["ia", "imagem", "audio", "ligacao"]) {
      const errors = validateCampaignMessages([{ ...tplMsg, tipo }], "meta", { wabaId: "waba-a", templateRows: [row] });
      expect(errors[0]).toMatch(/só para canais WAHA/);
    }
  });

  it("Meta: template de outra WABA (ausente no catálogo desta) bloqueia pedindo sync", () => {
    const errors = validateCampaignMessages([tplMsg], "meta", { wabaId: "waba-b", templateRows: [row] });
    expect(errors[0]).toMatch(/não encontrado no catálogo deste número — sincronize os templates/);
  });

  it("Meta: template sem mapa de variáveis é bloqueado", () => {
    const { template_variable_map: _omit, ...semMapa } = tplMsg;
    void _omit;
    const errors = validateCampaignMessages([semMapa], "meta", { wabaId: "waba-a", templateRows: [row] });
    expect(errors[0]).toMatch(/variáveis do template "cobranca_1" não foram mapeadas/);
  });

  it("Meta: template não aprovado ou com variáveis faltando bloqueia", () => {
    expect(
      validateCampaignMessages([tplMsg], "meta", { wabaId: "waba-a", templateRows: [{ ...row, status: "REJECTED" }] })[0]
    ).toMatch(/não está aprovado/);
    expect(
      validateCampaignMessages([{ ...tplMsg, template_variable_map: [{ type: "contact_field", field: "name" }] }], "meta", {
        wabaId: "waba-a",
        templateRows: [row],
      })[0]
    ).toMatch(/2 variáveis.*só 1/);
  });

  it("rótulo de rotação", () => {
    const errors = validateCampaignMessages([{ tipo: "texto" }], "meta", { wabaId: "waba-a", rotulo: "Template" });
    expect(errors[0]).toMatch(/^Template #1/);
  });

  it("WAHA: texto, IA, mídia e ligação são aceitos", () => {
    const msgs = ["texto", "ia", "imagem", "audio", "ligacao"].map((tipo) => ({ tipo }));
    expect(validateCampaignMessages(msgs, "waha")).toEqual([]);
  });

  it("sem mensagens", () => {
    expect(validateCampaignMessages([], "waha")).toEqual(["Adicione pelo menos uma mensagem."]);
  });
});

describe("validateCampaignConfig", () => {
  it("canais primeiro, depois mensagens", () => {
    expect(
      validateCampaignConfig({ sessionIds: ["a1", "w1"], channels: all, mensagens: [tplMsg], templateRows: [row] }).ok
    ).toBe(false);
    expect(
      validateCampaignConfig({ sessionIds: ["a1", "a2"], channels: all, mensagens: [tplMsg], templateRows: [row] })
    ).toEqual({ ok: true, provider: "meta", wabaId: "waba-a" });
    const r = validateCampaignConfig({
      sessionIds: ["b1"],
      channels: all,
      mensagens: [tplMsg],
      templateRows: [row],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sincronize os templates/);
  });

  it("WAHA ignora o catálogo Meta", () => {
    expect(
      validateCampaignConfig({ sessionIds: ["w1"], channels: all, mensagens: [{ tipo: "texto", conteudo: "Oi" }], templateRows: [] })
    ).toEqual({ ok: true, provider: "waha", wabaId: null });
  });
});

describe("utilitários", () => {
  it("campaignTemplateNames: únicos e sem vazios", () => {
    expect(campaignTemplateNames([tplMsg, tplMsg, { tipo: "texto" }, { template_name: " " }])).toEqual(["cobranca_1"]);
  });

  it("stripMessageTemplate remove só template_*", () => {
    expect(stripMessageTemplate(tplMsg)).toEqual({ tipo: "texto", conteudo: tplMsg.conteudo });
  });

  it("formatStartFailureReason menciona o agendamento em Brasília", () => {
    expect(formatStartFailureReason("Template X inválido", "2026-10-06T17:30:00.000Z")).toBe(
      "O início agendado para 06/10/2026, 14:30 (Brasília) falhou e a campanha voltou para rascunho: Template X inválido"
    );
    expect(formatStartFailureReason("erro", null)).toBe("O início falhou e a campanha voltou para rascunho: erro");
  });
});
