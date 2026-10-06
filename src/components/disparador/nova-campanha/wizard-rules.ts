// Regras puras do assistente "Nova campanha" (V2): estado do formulário,
// validação de cada passo, montagem do corpo para POST/PATCH e previsão.
// Sem React e sem I/O — testado em wizard-rules.test.ts. As regras de
// negócio vêm de campaign-validation.ts (as mesmas do servidor).

import {
  BUSINESS_DAYS,
  listCampaignConfigProblems,
  messagesPerContact,
  parseTemplateMode,
  stripMessageTemplate,
  validateCampaignChannels,
  validateCampaignSettings,
  type CampaignProvider,
  type TemplateMode,
} from "@/lib/disparador/campaign-validation";
import type { WizardChannel } from "@/lib/disparador/channel-filter";
import { forecastCampaign, IMEDIATO_BATCH_SIZE, type ForecastResult } from "@/lib/disparador/dispatch-forecast";
import type { ImportColumnMap } from "@/lib/disparador/import-mapping";
import {
  findVariableProblems,
  placeholderNumbers,
  synthesizeWahaVariableMap,
  type VariableSource,
} from "@/lib/disparador/preview-message";
import { brasiliaLocalToIso, parseHHMM } from "@/lib/disparador/send-window";
import { countBodyVariables, type LocalTemplateRow } from "@/lib/disparador/template-validation";
import {
  EMPTY_CAMPAIGN_WEBCHAT,
  campaignWebchatPayload,
  type CampaignWebchatValue,
} from "@/components/disparador/campaign-webchat-settings";

export type WizardStep = 1 | 2 | 3 | 4;

export const WIZARD_STEPS: ReadonlyArray<{ step: WizardStep; label: string }> = [
  { step: 1, label: "Origem" },
  { step: 2, label: "Configurações" },
  { step: 3, label: "Conteúdo" },
  { step: 4, label: "Revisão" },
];

/** Só dois modos (decisão de 06/10). Campanha antiga sem equivalente = null. */
export type DispatchMode = "imediato" | "segmentado";
/** "agendar" = começa sozinha na data inicial; "manual" = rascunho, inicia no botão. */
export type StartMode = "agendar" | "manual";

export interface WizardMessage {
  tipo: string;
  conteudo?: string;
  prompt?: string;
  url?: string;
  template_name?: string;
  template_language?: string;
  template_variable_map?: VariableSource[];
}

export interface WizardForm {
  nome: string;
  descricao: string;
  /** "" = todas as equipes. Não é salvo: filtra canais e templates. */
  teamId: string;
  sessionIds: string[];
  tags: string[];
  confirmAllContacts: boolean;
  startMode: StartMode;
  /** "AAAA-MM-DD" e "HH:MM", sempre no horário de Brasília. */
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  dispatchMode: DispatchMode | null;
  batchPercent: number;
  pauseMinutes: number;
  templateMode: TemplateMode;
  mensagens: WizardMessage[];
  webchat: CampaignWebchatValue;
}

export interface WizardImportState {
  /** Arquivo novo lido nesta sessão. */
  hasFile: boolean;
  loading: boolean;
  /** Contatos que entram (válidos, únicos, fora da blacklist). */
  validos: number;
  columnMap: ImportColumnMap;
}

export interface WizardContext {
  channels: readonly WizardChannel[];
  importState: WizardImportState;
  /** Edição de campanha com base já importada (não precisa reimportar). */
  keepsExistingAudience: boolean;
  /** Catálogo local dos templates escolhidos (para a validação Meta). */
  templateRows: readonly LocalTemplateRow[];
  /** O catálogo acima corresponde aos templates atuais. */
  catalogReady: boolean;
  now: Date;
}

// ---- Datas em Brasília (UTC-3 fixo, mesma premissa de send-window.ts) ----

const BR_OFFSET_MS = 3 * 3_600_000;

/** "AAAA-MM-DD" do dia de Brasília que contém `now`. */
export function brasiliaDate(now: Date): string {
  return new Date(now.getTime() - BR_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutos desde 00:00 em Brasília. */
function brasiliaMinutesOf(now: Date): number {
  const d = new Date(now.getTime() - BR_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = domingo … 6 = sábado. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function isBusinessDate(date: string): boolean {
  const w = weekdayOf(date);
  return w >= 1 && w <= 5;
}

export function nextBusinessDate(date: string): string {
  let d = date;
  while (!isBusinessDate(d)) d = addDays(d, 1);
  return d;
}

/** Instante ISO de "data + hora" de Brasília; null se inválido. */
export function scheduleIso(date: string, time: string): string | null {
  return brasiliaLocalToIso(`${date}T${time}`);
}

/** Horários oferecidos no seletor (passo de 30 min). */
export const TIME_OPTIONS: readonly string[] = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  return `${h}:${i % 2 === 0 ? "00" : "30"}`;
});

/**
 * Agendamento sugerido: hoje (dia útil) na próxima meia hora cheia a partir
 * das 08:00 se ainda couber antes das 17:00; senão o próximo dia útil às
 * 08:00. Janela até 18:00.
 */
export function defaultSchedule(now: Date): Pick<WizardForm, "startDate" | "startTime" | "endDate" | "endTime"> {
  const today = brasiliaDate(now);
  const minutes = brasiliaMinutesOf(now);
  const nextSlot = Math.max(8 * 60, Math.ceil((minutes + 1) / 30) * 30);
  if (isBusinessDate(today) && nextSlot <= 17 * 60) {
    const time = `${String(Math.floor(nextSlot / 60)).padStart(2, "0")}:${nextSlot % 60 === 0 ? "00" : "30"}`;
    return { startDate: today, startTime: time, endDate: today, endTime: "18:00" };
  }
  const day = nextBusinessDate(addDays(today, 1));
  return { startDate: day, startTime: "08:00", endDate: day, endTime: "18:00" };
}

export function emptyWizardForm(now: Date): WizardForm {
  return {
    nome: "",
    descricao: "",
    teamId: "",
    sessionIds: [],
    tags: [],
    confirmAllContacts: false,
    startMode: "agendar",
    ...defaultSchedule(now),
    dispatchMode: "imediato",
    batchPercent: 10,
    pauseMinutes: 30,
    templateMode: "sequencia",
    mensagens: [],
    webchat: EMPTY_CAMPAIGN_WEBCHAT,
  };
}

// ---- Edição: campanha salva → formulário ----

export interface SavedCampaign {
  nome: string;
  descricao?: string | null;
  session_ids?: string[] | null;
  tags_filtro?: string[] | null;
  mensagens?: WizardMessage[] | null;
  janela_inicio?: string | null;
  janela_fim?: string | null;
  agendamento?: string | null;
  agendamento_fim?: string | null;
  status: string;
  batch_size?: number | null;
  batch_pause_seconds?: number | null;
  batch_percent?: number | null;
  dias_permitidos?: unknown;
  audience_mode?: string | null;
  webchat_enabled?: boolean | null;
  webchat_flow_id?: string | null;
  webchat_message?: string | null;
  webchat_button_text?: string | null;
}

/** Modo salvo → modo da tela; combinação antiga (Balanceado etc.) = null. */
export function inferDispatchMode(
  batchSize: number | null | undefined,
  pauseSeconds: number | null | undefined,
  batchPercent: number | null | undefined
): DispatchMode | null {
  if (batchPercent != null) return "segmentado";
  if ((batchSize ?? 1) > 1 && (pauseSeconds ?? 0) === 0) return "imediato";
  return null;
}

function hhmm(value: string | null | undefined, fallback: string): string {
  const m = parseHHMM(value);
  if (m === null) return fallback;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function formFromCampaign(c: SavedCampaign, now: Date, teamId = ""): WizardForm {
  const base = emptyWizardForm(now);
  const startTime = hhmm(c.janela_inicio, base.startTime);
  const endTime = hhmm(c.janela_fim, base.endTime);
  const scheduled = c.status === "agendado" && c.agendamento ? new Date(c.agendamento) : null;
  const startDate = scheduled ? brasiliaDate(scheduled) : base.startDate;
  const endDate = c.agendamento_fim ? brasiliaDate(new Date(c.agendamento_fim)) : startDate;
  return {
    ...base,
    nome: c.nome ?? "",
    descricao: c.descricao ?? "",
    teamId,
    sessionIds: c.session_ids ?? [],
    tags: c.tags_filtro ?? [],
    confirmAllContacts: c.audience_mode === "account" && (c.tags_filtro ?? []).length === 0,
    startMode: scheduled ? "agendar" : "manual",
    startDate,
    startTime,
    endDate: endDate < startDate ? startDate : endDate,
    endTime,
    dispatchMode: inferDispatchMode(c.batch_size, c.batch_pause_seconds, c.batch_percent),
    // Sempre reinicia quando a campanha não era Segmentada (bug: ficava o
    // valor da edição anterior).
    batchPercent: c.batch_percent ?? 10,
    pauseMinutes: c.batch_percent != null ? Math.max(1, Math.round((c.batch_pause_seconds ?? 0) / 60)) : 30,
    templateMode: parseTemplateMode(c.dias_permitidos),
    mensagens: Array.isArray(c.mensagens) ? c.mensagens : [],
    webchat: {
      webchat_enabled: c.webchat_enabled ?? false,
      webchat_flow_id: c.webchat_flow_id ?? null,
      webchat_message: c.webchat_message ?? "",
      webchat_button_text: c.webchat_button_text ?? "",
    },
  };
}

// ---- Derivados ----

export function selectedProvider(form: WizardForm, ctx: Pick<WizardContext, "channels">): CampaignProvider | null {
  const r = validateCampaignChannels(form.sessionIds, ctx.channels);
  return r.ok ? r.provider : null;
}

export function campaignWabaId(form: WizardForm, ctx: Pick<WizardContext, "channels">): string | null {
  const r = validateCampaignChannels(form.sessionIds, ctx.channels);
  return r.ok && r.provider === "meta" ? r.wabaId : null;
}

/** Origem do público que vai para campaigns.audience_mode. */
export function audienceModeOf(
  form: WizardForm,
  ctx: Pick<WizardContext, "importState" | "keepsExistingAudience">
): "csv" | "tags" | "account" {
  if (ctx.importState.hasFile || ctx.keepsExistingAudience) return "csv";
  return form.tags.length > 0 ? "tags" : "account";
}

/** Há colunas do CSV conhecidas nesta sessão (para oferecer VAR1–3). */
export function csvColumnsAvailable(ctx: Pick<WizardContext, "importState" | "keepsExistingAudience">): boolean {
  return ctx.importState.hasFile || ctx.keepsExistingAudience;
}

/**
 * Mensagem a partir de um template aprovado: corpo somente leitura e mapa
 * padrão das variáveis — {{n}} → coluna VARn do CSV quando ela foi mapeada;
 * senão {{1}} → nome do contato e as demais → valor fixo (a preencher).
 */
export function messageFromTemplate(
  template: Pick<LocalTemplateRow, "name" | "language" | "body_text">,
  columnMap: ImportColumnMap,
  hasCsv: boolean
): WizardMessage {
  const count = countBodyVariables(template.body_text);
  const columns = [columnMap.var1, columnMap.var2, columnMap.var3];
  const map: VariableSource[] = Array.from({ length: count }, (_, idx) =>
    hasCsv && idx < 3 && columns[idx]
      ? { type: "csv_var", index: idx as 0 | 1 | 2 }
      : idx === 0
        ? { type: "contact_field", field: "name" }
        : { type: "static", value: "" }
  );
  return {
    tipo: "texto",
    conteudo: template.body_text ?? "",
    template_name: template.name,
    template_language: template.language ?? "pt_BR",
    template_variable_map: map,
  };
}

/**
 * Troca de provedor/WABA: os templates escolhidos eram da WABA anterior.
 * Meta → mensagens limpas (escolher de novo); WAHA → mantém textos sem
 * template_*; ligação some (não existe mais).
 */
export function resetMessagesForChannelChange(mensagens: readonly WizardMessage[], nextProvider: CampaignProvider | null): WizardMessage[] {
  if (nextProvider === "meta") return [];
  return mensagens
    .filter((m) => m.template_name == null && m.tipo !== "ligacao")
    .map((m) => stripMessageTemplate(m));
}

// ---- Corpo para POST/PATCH ----

export function buildCampaignPayload(form: WizardForm, ctx: WizardContext, draftId: string | null) {
  const provider = selectedProvider(form, ctx);
  const segmentado = form.dispatchMode === "segmentado";
  const contacts = ctx.importState.hasFile ? ctx.importState.validos : 0;
  const mensagens =
    provider === "meta"
      ? form.mensagens
      : form.mensagens.map((m) => synthesizeWahaVariableMap(m, ctx.importState.columnMap));
  const agendamento = form.startMode === "agendar" ? scheduleIso(form.startDate, form.startTime) : null;
  const agendamentoFim = form.startMode === "agendar" ? scheduleIso(form.endDate, form.endTime) : null;
  return {
    nome: form.nome.trim(),
    descricao: form.descricao.trim(),
    session_ids: form.sessionIds,
    tags_filtro: form.tags,
    mensagens,
    // Janela diária = [hora inicial, hora final]; só dias úteis.
    janela_inicio: form.startTime,
    janela_fim: form.endTime,
    dias_envio: [...BUSINESS_DAYS],
    agendamento,
    agendamento_fim: agendamentoFim,
    // Imediato: um lote só (o cron envia até 700 por minuto); Segmentado:
    // X% da base a cada Y min — startCampaign recalcula batch_size pelo
    // total real no início. Intervalos não se aplicam ao envio em lote.
    batch_size: segmentado ? Math.max(1, Math.ceil((contacts * form.batchPercent) / 100)) : IMEDIATO_BATCH_SIZE,
    batch_pause_seconds: segmentado ? Math.round(form.pauseMinutes * 60) : 0,
    batch_percent: segmentado ? form.batchPercent : null,
    intervalo_min: segmentado ? 1 : 0,
    intervalo_max: segmentado ? 3 : 0,
    dias_permitidos: form.templateMode,
    audience_mode: audienceModeOf(form, ctx),
    ...campaignWebchatPayload(form.webchat),
    confirm_all_contacts: form.confirmAllContacts,
    draft_id: draftId,
  };
}

// ---- Validação por passo ----

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

export function validateWizardStep(step: WizardStep, form: WizardForm, ctx: WizardContext): string[] {
  const errors: string[] = [];
  if (step === 1) {
    if (!form.nome.trim()) errors.push("Informe o nome da campanha.");
    const channels = validateCampaignChannels(form.sessionIds, ctx.channels);
    if (!channels.ok) errors.push(channels.error);
    const imp = ctx.importState;
    if (imp.loading) errors.push("Aguarde a leitura do arquivo terminar.");
    if (imp.hasFile) {
      if (!imp.columnMap.phone) errors.push("No mapeamento de colunas, escolha a coluna do telefone.");
      else if (imp.validos === 0) errors.push("A base importada não tem nenhum contato válido para envio.");
    } else if (!ctx.keepsExistingAudience && form.tags.length === 0 && !form.confirmAllContacts) {
      errors.push("Defina o público: importe uma base, escolha uma tabulação ou confirme o envio para todos os contatos da conta.");
    }
    return uniq(errors);
  }

  if (step === 2) {
    if (!form.dispatchMode) {
      errors.push("Escolha o modo de disparo: Imediato ou Segmentado.");
    }
    if (form.startMode === "agendar") {
      if (!isBusinessDate(form.startDate)) errors.push("A data inicial precisa ser um dia útil (segunda a sexta).");
      if (form.endDate < form.startDate) errors.push("A data final não pode ser antes da data inicial.");
    }
    const payload = buildCampaignPayload(form, ctx, null);
    errors.push(
      ...validateCampaignSettings(
        {
          nome: form.nome.trim() || "—",
          janela_inicio: payload.janela_inicio,
          janela_fim: payload.janela_fim,
          dias_envio: payload.dias_envio,
          agendamento: payload.agendamento,
          agendamento_fim: payload.agendamento_fim,
          batch_size: payload.batch_size,
          batch_pause_seconds: payload.batch_pause_seconds,
          batch_percent: payload.batch_percent,
          dias_permitidos: payload.dias_permitidos,
        },
        { now: ctx.now }
      )
    );
    return uniq(errors);
  }

  if (step === 3) {
    const provider = selectedProvider(form, ctx);
    if (!provider) return ["Escolha os canais no passo Origem."];
    if (form.mensagens.length === 0) {
      return [provider === "meta" ? "Escolha o template da campanha." : "Escreva a mensagem da campanha."];
    }
    if (provider === "meta" && !ctx.catalogReady) return ["Aguarde: conferindo os templates no catálogo do número."];
    const payload = buildCampaignPayload(form, ctx, null);
    const { problems } = listCampaignConfigProblems({
      sessionIds: form.sessionIds,
      channels: ctx.channels,
      mensagens: payload.mensagens,
      templateRows: ctx.templateRows,
      templateMode: form.templateMode,
      audienceMode: payload.audience_mode,
    });
    errors.push(...problems);
    const rotulo = form.templateMode === "sequencia" ? "Mensagem" : "Variação";
    form.mensagens.forEach((m, i) => {
      for (const p of findVariableProblems(m, {
        columnMap: ctx.importState.columnMap,
        hasCsv: ctx.importState.hasFile,
      })) {
        errors.push(`${rotulo} #${i + 1}: ${p}`);
      }
    });
    return uniq(errors);
  }

  return uniq([1, 2, 3].flatMap((s) => validateWizardStep(s as WizardStep, form, ctx)));
}

/** Primeiro passo com erro até `target` (exclusive), ou null. */
export function firstInvalidStep(target: WizardStep, form: WizardForm, ctx: WizardContext): WizardStep | null {
  for (let s = 1; s < target; s++) {
    if (validateWizardStep(s as WizardStep, form, ctx).length > 0) return s as WizardStep;
  }
  return null;
}

// ---- Previsão ----

/**
 * Previsão de término para o formulário. `contacts` = público conhecido
 * (base importada ou prévia do público); null = desconhecido.
 */
export function forecastForForm(form: WizardForm, contacts: number | null, now: Date): ForecastResult | null {
  if (contacts == null || contacts <= 0 || !form.dispatchMode) return null;
  const startIso = form.startMode === "agendar" ? scheduleIso(form.startDate, form.startTime) : null;
  const start = startIso ? new Date(startIso) : now;
  if (parseHHMM(form.startTime) === null || parseHHMM(form.endTime) === null || form.endTime <= form.startTime) return null;
  return forecastCampaign({
    contacts,
    messagesPerContact: messagesPerContact(form.templateMode, form.mensagens.length || 1),
    dispatch:
      form.dispatchMode === "segmentado"
        ? { mode: "segmentado", percent: form.batchPercent, pauseMinutes: form.pauseMinutes }
        : { mode: "imediato" },
    start,
    janela: { inicio: form.startTime, fim: form.endTime, dias: [...BUSINESS_DAYS] },
  });
}

/** {{n}} distintos de um texto (para o mapeamento de variáveis do WAHA). */
export function textVariables(text: string | undefined): number[] {
  return placeholderNumbers(text ?? "");
}
