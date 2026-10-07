import { describe, expect, it } from "vitest";
import {
  audienceModeOf,
  buildCampaignPayload,
  defaultSchedule,
  emptyWizardForm,
  firstInvalidStep,
  forecastForForm,
  formFromCampaign,
  inferDispatchMode,
  messageFromTemplate,
  resetMessagesForChannelChange,
  validateWizardStep,
  type WizardContext,
  type WizardForm,
} from "./wizard-rules";
import type { WizardChannel } from "@/lib/disparador/channel-filter";
import type { LocalTemplateRow } from "@/lib/disparador/template-validation";

// Terça, 06/10/2026, 09:10 em Brasília.
const now = new Date("2026-10-06T12:10:00.000Z");

const metaA: WizardChannel = { id: "a1", provider: "meta", waba_id: "waba-a", habilitado: true, team_id: "t1" };
const waha: WizardChannel = { id: "w1", provider: "waha", habilitado: true, team_id: "t1" };
const channels = [metaA, waha];

const tplRow: LocalTemplateRow = {
  name: "cobranca_1",
  language: "pt_BR",
  status: "APPROVED",
  waba_id: "waba-a",
  body_text: "Olá {{1}}, seu débito é {{2}}.",
};
const tplRow2: LocalTemplateRow = { ...tplRow, name: "cobranca_2", body_text: "Oi {{1}}." };

function ctx(overrides: Partial<WizardContext> = {}): WizardContext {
  return {
    channels,
    importState: { hasFile: true, loading: false, validos: 1000, columnMap: { phone: "telefone", var1: "nome", var2: "valor" } },
    keepsExistingAudience: false,
    templateRows: [tplRow, tplRow2],
    catalogReady: true,
    now,
    ...overrides,
  };
}

function form(overrides: Partial<WizardForm> = {}): WizardForm {
  return { ...emptyWizardForm(now), nome: "Cobrança", sessionIds: ["a1"], ...overrides };
}

describe("agenda padrão (Brasília, dia útil)", () => {
  it("hoje na próxima meia hora quando ainda cabe", () => {
    expect(defaultSchedule(now)).toEqual({ startDate: "2026-10-06", startTime: "09:30", endDate: "2026-10-06", endTime: "18:00" });
  });
  it("sexta à noite → segunda 08:00", () => {
    expect(defaultSchedule(new Date("2026-10-09T23:00:00.000Z"))).toMatchObject({ startDate: "2026-10-12", startTime: "08:00" });
  });
  it("antes das 08:00 → 08:00 de hoje", () => {
    expect(defaultSchedule(new Date("2026-10-06T09:00:00.000Z")).startTime).toBe("08:00");
  });
});

describe("passo 1 — Origem", () => {
  it("nome, canais e base", () => {
    expect(validateWizardStep(1, form({ nome: "" }), ctx())).toEqual(["Informe o nome da campanha."]);
    expect(validateWizardStep(1, form({ sessionIds: ["a1", "w1"] }), ctx())[0]).toMatch(/misturar/);
    expect(validateWizardStep(1, form(), ctx({ importState: { hasFile: true, loading: false, validos: 0, columnMap: { phone: "t" } } }))[0]).toMatch(
      /nenhum contato válido/
    );
  });

  it("sem base: tabulação ou aceite da conta inteira", () => {
    const semBase = ctx({ importState: { hasFile: false, loading: false, validos: 0, columnMap: {} } });
    expect(validateWizardStep(1, form(), semBase)[0]).toMatch(/Defina o público/);
    expect(validateWizardStep(1, form({ tags: ["Promessa"] }), semBase)).toEqual([]);
    expect(validateWizardStep(1, form({ confirmAllContacts: true }), semBase)).toEqual([]);
    expect(audienceModeOf(form({ tags: ["Promessa"] }), semBase)).toBe("tags");
    expect(audienceModeOf(form(), semBase)).toBe("account");
    expect(audienceModeOf(form(), ctx())).toBe("csv");
  });
});

describe("passo 2 — Configurações", () => {
  it("agenda válida", () => {
    expect(validateWizardStep(2, form(), ctx())).toEqual([]);
  });

  it("hora final antes da inicial, sábado e data final antes da inicial", () => {
    expect(validateWizardStep(2, form({ startTime: "18:00", endTime: "08:00" }), ctx()).join(" ")).toMatch(/hora final precisa ser depois/);
    expect(validateWizardStep(2, form({ startDate: "2026-10-10", endDate: "2026-10-10" }), ctx())[0]).toMatch(/dia útil/);
    expect(validateWizardStep(2, form({ startDate: "2026-10-07", endDate: "2026-10-06" }), ctx()).join(" ")).toMatch(
      /data final não pode ser antes/
    );
  });

  it("início no passado", () => {
    expect(validateWizardStep(2, form({ startDate: "2026-10-06", startTime: "08:00" }), ctx()).join(" ")).toMatch(/no futuro/);
    // Início manual: só a janela importa.
    expect(validateWizardStep(2, form({ startMode: "manual", startDate: "2026-10-01", endDate: "2026-10-01" }), ctx())).toEqual([]);
  });

  it("modo de disparo obrigatório e faixas do Segmentado", () => {
    expect(validateWizardStep(2, form({ dispatchMode: null }), ctx())[0]).toMatch(/Escolha o modo de disparo/);
    expect(validateWizardStep(2, form({ dispatchMode: "segmentado", batchPercent: 70 }), ctx())[0]).toMatch(/1% a 50%/);
    expect(validateWizardStep(2, form({ dispatchMode: "segmentado", batchPercent: 10, pauseMinutes: 0 }), ctx())[0]).toMatch(
      /pelo menos 1 minuto/
    );
  });
});

describe("passo 3 — Conteúdo", () => {
  const msg1 = messageFromTemplate(tplRow, { var1: "nome", var2: "valor" }, true);
  const msg2 = messageFromTemplate(tplRow2, {}, true);

  it("template novo: {{n}} → coluna VARn mapeada, senão nome/fixo", () => {
    expect(msg1.template_variable_map).toEqual([
      { type: "csv_var", index: 0 },
      { type: "csv_var", index: 1 },
    ]);
    expect(messageFromTemplate(tplRow, {}, false).template_variable_map).toEqual([
      { type: "contact_field", field: "name" },
      { type: "static", value: "" },
    ]);
  });

  it("Padrão Meta = exatamente 1 template; Rotação = 2+", () => {
    expect(validateWizardStep(3, form({ mensagens: [msg1] }), ctx())).toEqual([]);
    expect(validateWizardStep(3, form({ mensagens: [msg1, msg2] }), ctx())[0]).toMatch(/exatamente 1 template/);
    expect(validateWizardStep(3, form({ templateMode: "rotacao", mensagens: [msg1] }), ctx())[0]).toMatch(/pelo menos 2 templates/);
    expect(validateWizardStep(3, form({ templateMode: "rotacao", mensagens: [msg1, msg2] }), ctx())).toEqual([]);
  });

  it("valor fixo vazio e coluna do CSV sem base", () => {
    const vazio = messageFromTemplate(tplRow, {}, false);
    expect(validateWizardStep(3, form({ mensagens: [vazio] }), ctx()).join(" ")).toMatch(/valor fixo vazio/);
    const semBase = ctx({ importState: { hasFile: false, loading: false, validos: 0, columnMap: {} } });
    expect(validateWizardStep(3, form({ tags: ["x"], mensagens: [msg1] }), semBase).join(" ")).toMatch(
      /coluna do CSV, mas a campanha não tem base/
    );
  });

  it("espera o catálogo antes de validar templates", () => {
    expect(validateWizardStep(3, form({ mensagens: [msg1] }), ctx({ catalogReady: false }))[0]).toMatch(/Aguarde/);
  });

  it("WAHA: sequência no Padrão; texto vazio bloqueia", () => {
    const wahaForm = form({
      sessionIds: ["w1"],
      mensagens: [
        { tipo: "texto", conteudo: "Oi {{nome}}, valor {{2}}" },
        { tipo: "imagem", url: "https://x/boleto.png" },
      ],
    });
    expect(validateWizardStep(3, wahaForm, ctx())).toEqual([]);
    expect(validateWizardStep(3, { ...wahaForm, mensagens: [{ tipo: "texto", conteudo: "" }] }, ctx())[0]).toMatch(/escreva o texto/);
  });

  it("revisão junta os erros de todos os passos e aponta o primeiro passo inválido", () => {
    const bad = form({ nome: "", dispatchMode: null, mensagens: [] });
    expect(validateWizardStep(4, bad, ctx()).length).toBeGreaterThanOrEqual(3);
    expect(firstInvalidStep(4, bad, ctx())).toBe(1);
    expect(firstInvalidStep(4, form({ mensagens: [msg1] }), ctx())).toBeNull();
  });
});

describe("corpo enviado ao servidor", () => {
  it("Imediato agendado: janela = horas, dias úteis, lote único", () => {
    const p = buildCampaignPayload(
      form({ startDate: "2026-10-07", startTime: "08:00", endDate: "2026-10-08", endTime: "17:30", mensagens: [] }),
      ctx(),
      "draft"
    );
    expect(p).toMatchObject({
      janela_inicio: "08:00",
      janela_fim: "17:30",
      dias_envio: [1, 2, 3, 4, 5],
      agendamento: "2026-10-07T11:00:00.000Z",
      agendamento_fim: "2026-10-08T20:30:00.000Z",
      batch_size: 999_999,
      batch_pause_seconds: 0,
      batch_percent: null,
      dias_permitidos: "sequencia",
      audience_mode: "csv",
      draft_id: "draft",
    });
  });

  it("Segmentado: X% e Y min nas colunas de sempre; manual = sem agendamento", () => {
    const p = buildCampaignPayload(
      form({ dispatchMode: "segmentado", batchPercent: 10, pauseMinutes: 30, startMode: "manual" }),
      ctx(),
      null
    );
    expect(p).toMatchObject({ batch_percent: 10, batch_pause_seconds: 1800, batch_size: 100, agendamento: null, agendamento_fim: null });
  });

  it("WAHA: {{n}} digitado ganha o mapa das colunas VARn", () => {
    const p = buildCampaignPayload(form({ sessionIds: ["w1"], mensagens: [{ tipo: "texto", conteudo: "Valor {{2}}" }] }), ctx(), null);
    expect(p.mensagens[0].template_variable_map?.[1]).toEqual({ type: "csv_var", index: 1 });
  });
});

describe("edição e troca de canal", () => {
  it("formFromCampaign: agendada volta com datas/horas; modo antigo pede escolha", () => {
    const f = formFromCampaign(
      {
        nome: "X",
        status: "agendado",
        agendamento: "2026-10-07T11:00:00.000Z",
        agendamento_fim: "2026-10-09T21:00:00.000Z",
        janela_inicio: "08:00:00",
        janela_fim: "18:00:00",
        batch_size: 1,
        batch_pause_seconds: 0,
        batch_percent: null,
        dias_permitidos: [1, 2, 3, 4, 5, 6],
      },
      now
    );
    expect(f).toMatchObject({
      startMode: "agendar",
      startDate: "2026-10-07",
      startTime: "08:00",
      endDate: "2026-10-09",
      endTime: "18:00",
      dispatchMode: null,
      batchPercent: 10,
      pauseMinutes: 30,
      templateMode: "sequencia",
    });
    expect(formFromCampaign({ nome: "Y", status: "rascunho", agendamento: "2026-10-01T11:00:00.000Z" }, now).startMode).toBe("manual");
  });

  it("inferDispatchMode", () => {
    expect(inferDispatchMode(999_999, 0, null)).toBe("imediato");
    expect(inferDispatchMode(100, 1800, 10)).toBe("segmentado");
    expect(inferDispatchMode(1, 0, null)).toBeNull();
  });

  it("trocar para Meta limpa; para WAHA tira template e ligação", () => {
    const msgs = [
      { tipo: "texto", conteudo: "a", template_name: "t" },
      { tipo: "texto", conteudo: "b" },
      { tipo: "ligacao", url: "u" },
    ];
    expect(resetMessagesForChannelChange(msgs, "meta")).toEqual([]);
    expect(resetMessagesForChannelChange(msgs, "waha")).toEqual([{ tipo: "texto", conteudo: "b" }]);
  });
});

describe("previsão no formulário", () => {
  it("usa o agendamento, a janela e o modo", () => {
    const f = form({ startDate: "2026-10-07", startTime: "08:00", endTime: "18:00", mensagens: [] });
    const r = forecastForForm(f, 1000, now);
    expect(r?.firstSendAt.toISOString()).toBe("2026-10-07T11:00:00.000Z");
    expect(r?.conservador.end.toISOString()).toBe("2026-10-07T11:15:00.000Z");
    expect(forecastForForm(f, null, now)).toBeNull();
    expect(forecastForForm({ ...f, dispatchMode: null }, 1000, now)).toBeNull();
  });
});
