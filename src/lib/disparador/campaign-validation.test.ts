import { describe, expect, it } from "vitest";
import {
  campaignChannelGroupKey,
  campaignTemplateNames,
  decideCampaignStatus,
  formatStartFailureReason,
  messagesPerContact,
  parseTemplateMode,
  stripMessageTemplate,
  validateCampaignChannels,
  validateCampaignConfig,
  validateCampaignMessages,
  validateCampaignSettings,
  validateTemplateMode,
  validateVariableSources,
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

  it("WAHA: texto, IA, imagem e áudio com conteúdo são aceitos", () => {
    const msgs = [
      { tipo: "texto", conteudo: "Oi {{nome}}" },
      { tipo: "ia", prompt: "Cobre com educação" },
      { tipo: "imagem", url: "https://x/img.png" },
      { tipo: "audio", url: "https://x/a.ogg" },
    ];
    expect(validateCampaignMessages(msgs, "waha")).toEqual([]);
  });

  it("WAHA: ligação saiu; conteúdo vazio e template Meta são bloqueados", () => {
    expect(validateCampaignMessages([{ tipo: "ligacao", url: "https://x/a.wav" }], "waha")[0]).toMatch(
      /ligação não é mais enviada/
    );
    const errors = validateCampaignMessages(
      [{ tipo: "texto", conteudo: " " }, { tipo: "ia" }, { tipo: "imagem" }, { ...tplMsg }],
      "waha"
    );
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/Mensagem #1: escreva o texto/);
    expect(errors[1]).toMatch(/prompt da IA/);
    expect(errors[2]).toMatch(/imagem/);
    expect(errors[3]).toMatch(/não enviam template da Meta/);
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

describe("validateTemplateMode (Padrão / Rotação / Aleatório)", () => {
  const tpl2 = { ...tplMsg, template_name: "cobranca_2" };
  const texto = { tipo: "texto", conteudo: "Oi" };

  it("Padrão: Meta exige exatamente 1 template", () => {
    expect(validateTemplateMode([tplMsg], "meta", "sequencia")).toEqual([]);
    expect(validateTemplateMode([tplMsg, tpl2], "meta", "sequencia")[0]).toMatch(/exatamente 1 template/);
  });

  it("Padrão: WAHA aceita sequência de várias partes", () => {
    expect(validateTemplateMode([texto, { tipo: "imagem", url: "u" }, texto], "waha", "sequencia")).toEqual([]);
  });

  it("Rotação/Aleatório exigem 2 ou mais", () => {
    for (const mode of ["rotacao", "aleatorio"] as const) {
      expect(validateTemplateMode([tplMsg], "meta", mode)[0]).toMatch(/pelo menos 2 templates/);
      expect(validateTemplateMode([texto], "waha", mode)[0]).toMatch(/pelo menos 2 mensagens/);
      expect(validateTemplateMode([tplMsg, tpl2], "meta", mode)).toEqual([]);
      expect(validateTemplateMode([texto, texto], "waha", mode)).toEqual([]);
    }
  });

  it("Rotação Meta: o mesmo template duas vezes é bloqueado", () => {
    expect(validateTemplateMode([tplMsg, tplMsg], "meta", "rotacao")[0]).toMatch(/mais de uma vez/);
  });

  it("parseTemplateMode: legado [1..6] = Padrão; messagesPerContact", () => {
    expect(parseTemplateMode([1, 2, 3, 4, 5, 6])).toBe("sequencia");
    expect(parseTemplateMode("rotacao")).toBe("rotacao");
    expect(messagesPerContact("sequencia", 3)).toBe(3);
    expect(messagesPerContact("aleatorio", 3)).toBe(1);
  });

  it("validateCampaignConfig aplica o modo quando informado", () => {
    const r = validateCampaignConfig({
      sessionIds: ["a1"],
      channels: all,
      mensagens: [tplMsg],
      templateRows: [row],
      templateMode: "rotacao",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Rotação precisa de pelo menos 2/);
  });
});

describe("validateVariableSources", () => {
  it("valor fixo vazio, campo desconhecido e coluna do CSV sem base", () => {
    const msg = {
      template_variable_map: [
        { type: "static", value: " " },
        { type: "contact_field", field: "email" },
        { type: "csv_var", index: 0 },
        { type: "contact_field", field: "cpf" },
        { type: "utm_link" },
      ],
    };
    const semBase = validateVariableSources([msg], "tags");
    expect(semBase).toHaveLength(3);
    expect(semBase[0]).toMatch(/\{\{1\}\} está como valor fixo vazio/);
    expect(semBase[1]).toMatch(/\{\{2\}\} usa um campo de contato desconhecido/);
    expect(semBase[2]).toMatch(/\{\{3\}\} usa uma coluna do CSV, mas a campanha não tem base/);
    // Com base importada (ou campanha antiga sem audience_mode) a coluna vale.
    expect(validateVariableSources([msg], "csv")).toHaveLength(2);
    expect(validateVariableSources([msg], null)).toHaveLength(2);
  });
});

describe("validateCampaignSettings", () => {
  const now = new Date("2026-10-06T12:00:00.000Z"); // 09:00 em Brasília
  const base = {
    nome: "Cobrança outubro",
    janela_inicio: "08:00",
    janela_fim: "18:00",
    dias_envio: [1, 2, 3, 4, 5],
    batch_size: 999999,
    batch_pause_seconds: 0,
    batch_percent: null,
    intervalo_min: 0,
    intervalo_max: 0,
    audience_mode: "csv",
    dias_permitidos: "sequencia",
  };

  it("configuração válida, agendada no futuro", () => {
    expect(
      validateCampaignSettings(
        { ...base, agendamento: "2026-10-07T11:00:00.000Z", agendamento_fim: "2026-10-08T21:00:00.000Z" },
        { now }
      )
    ).toEqual([]);
  });

  it("janela: formato HH:MM e fim depois do início", () => {
    expect(validateCampaignSettings({ ...base, janela_inicio: "08:00:00" }, { now })[0]).toMatch(/HH:MM/);
    expect(validateCampaignSettings({ ...base, janela_inicio: "18:00", janela_fim: "08:00" }, { now })[0]).toMatch(
      /hora final precisa ser depois/
    );
  });

  it("agendamento no passado (ou a menos de 1 min) e final antes do início", () => {
    expect(validateCampaignSettings({ ...base, agendamento: "2026-10-06T12:00:30.000Z" }, { now })[0]).toMatch(
      /no futuro/
    );
    expect(
      validateCampaignSettings(
        { ...base, agendamento: "2026-10-07T11:00:00.000Z", agendamento_fim: "2026-10-07T10:00:00.000Z" },
        { now }
      )[0]
    ).toMatch(/final precisam ser depois/);
  });

  it("Segmentado: 1–50% e intervalo de pelo menos 1 min", () => {
    expect(validateCampaignSettings({ ...base, batch_percent: 80, batch_pause_seconds: 600 }, { now })[0]).toMatch(
      /1% a 50%/
    );
    expect(validateCampaignSettings({ ...base, batch_percent: 10, batch_pause_seconds: 30 }, { now })[0]).toMatch(
      /pelo menos 1 minuto/
    );
  });

  it("conta inteira exige aceite; nome obrigatório; modo inválido", () => {
    expect(
      validateCampaignSettings({ ...base, audience_mode: "account" }, { now, requireAudience: true })[0]
    ).toMatch(/confirme o envio para todos/);
    expect(
      validateCampaignSettings({ ...base, audience_mode: "account" }, { now, requireAudience: true, confirmAllContacts: true })
    ).toEqual([]);
    expect(validateCampaignSettings({ ...base, nome: " " }, { now })[0]).toMatch(/nome da campanha/);
    expect(validateCampaignSettings({ ...base, dias_permitidos: "sorteio" }, { now })[0]).toMatch(/Modo de templates/);
  });

  it("decideCampaignStatus", () => {
    expect(decideCampaignStatus("2026-10-07T11:00:00.000Z")).toBe("agendado");
    expect(decideCampaignStatus(null)).toBe("rascunho");
    expect(decideCampaignStatus("")).toBe("rascunho");
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
