// Regras de configuração de campanha do disparador — fonte única usada
// pelo servidor (PATCH /api/disparador/campaigns/[id] e startCampaign.ts,
// via campaign-config-check.ts) e pelo assistente (campanhas/page.tsx).
// Funções puras, sem I/O: quem chama carrega canais e catálogo.
//
// Regras (V1):
//   - Uma campanha usa um único tipo de canal: só Meta ou só WAHA. As
//     lógicas de envio são incompatíveis (CLAUDE.md: nunca unificar).
//   - Campanha Meta usa uma única WABA (um ou mais números dela). Os
//     templates são da WABA — número sem waba_id não pode ser usado.
//   - Canal desabilitado (habilitado=false) não recebe envios.
//   - Meta: toda mensagem é um template aprovado (texto livre, IA, imagem,
//     áudio e ligação só em WAHA), presente no catálogo local da WABA e
//     compatível (template-validation.ts).

import {
  validateCampaignTemplate,
  type LocalTemplateRow,
} from "@/lib/disparador/template-validation";
import { formatBrasilia } from "@/lib/disparador/send-window";

export type CampaignProvider = "meta" | "waha";

/** Colunas de wacrm.whatsapp_config usadas na validação. */
export interface CampaignChannel {
  id: string;
  provider: string | null;
  waba_id?: string | null;
  /** undefined = não informado (tratado como habilitado). */
  habilitado?: boolean | null;
  /** Rótulo para mensagens de erro (número, sessão…). */
  label?: string | null;
}

export const CAMPAIGN_CHANNEL_COLUMNS =
  "id, provider, waba_id, habilitado, display_phone_number, waha_session";

export type ChannelSelectionResult =
  | { ok: true; provider: "meta"; wabaId: string }
  | { ok: true; provider: "waha"; wabaId: null }
  | { ok: false; error: string };

function channelLabel(channel: CampaignChannel): string {
  return channel.label?.trim() || (channel.provider === "meta" ? "número Meta" : "sessão WAHA");
}

function isMeta(channel: CampaignChannel): boolean {
  return channel.provider === "meta";
}

/**
 * Valida os canais escolhidos. `channels` = canais da conta (os que não
 * estiverem na lista são tratados como removidos / de outra conta).
 */
export function validateCampaignChannels(
  sessionIds: readonly string[],
  channels: readonly CampaignChannel[]
): ChannelSelectionResult {
  if (sessionIds.length === 0) return { ok: false, error: "Selecione pelo menos um canal." };
  const byId = new Map(channels.map((c) => [c.id, c]));
  const selected: CampaignChannel[] = [];
  for (const id of new Set(sessionIds)) {
    const channel = byId.get(id);
    if (!channel) {
      return {
        ok: false,
        error: "Um dos canais selecionados não existe mais ou não pertence a esta conta. Remova-o da campanha.",
      };
    }
    selected.push(channel);
  }

  const disabled = selected.find((c) => c.habilitado === false);
  if (disabled) {
    return {
      ok: false,
      error: `O canal ${channelLabel(disabled)} está desabilitado. Remova-o da campanha ou habilite-o em Canais.`,
    };
  }

  const metas = selected.filter(isMeta);
  if (metas.length > 0 && metas.length < selected.length) {
    return {
      ok: false,
      error:
        "Não é possível misturar canais oficiais (Meta) e WAHA na mesma campanha. Crie uma campanha para cada tipo de canal.",
    };
  }
  if (metas.length === 0) return { ok: true, provider: "waha", wabaId: null };

  const semWaba = metas.find((c) => !c.waba_id);
  if (semWaba) {
    return {
      ok: false,
      error: `O ${channelLabel(semWaba)} não tem WABA (conta WhatsApp Business) configurada e não pode ser usado em campanha. Reconecte o canal em Canais.`,
    };
  }
  const wabas = new Set(metas.map((c) => c.waba_id as string));
  if (wabas.size > 1) {
    return {
      ok: false,
      error:
        "Os números Meta selecionados são de contas WhatsApp Business (WABA) diferentes. Uma campanha Meta usa uma única WABA: selecione só números da mesma conta.",
    };
  }
  return { ok: true, provider: "meta", wabaId: [...wabas][0] };
}

/**
 * Identifica o "grupo" de canais da seleção: "waha", "meta:<waba>" ou
 * null (nada selecionado / seleção inválida). Trocar de grupo invalida os
 * templates já escolhidos (são da WABA); trocar de número dentro da mesma
 * WABA não.
 */
export function campaignChannelGroupKey(
  sessionIds: readonly string[],
  channels: readonly CampaignChannel[]
): string | null {
  const selected = channels.filter((c) => sessionIds.includes(c.id));
  if (selected.length === 0) return null;
  const metas = selected.filter(isMeta);
  if (metas.length === 0) return "waha";
  if (metas.length < selected.length) return null;
  const wabas = new Set(metas.map((c) => c.waba_id ?? ""));
  if (wabas.size !== 1) return null;
  return `meta:${[...wabas][0]}`;
}

/** Campos da mensagem (campaigns.mensagens[i]) usados na validação. */
export interface CampaignMessageFields {
  tipo?: unknown;
  conteudo?: unknown;
  prompt?: unknown;
  url?: unknown;
  template_name?: unknown;
  template_language?: unknown;
  template_variable_map?: unknown;
}

/** Remove template_* da mensagem (troca de provider/WABA). */
export function stripMessageTemplate<T extends CampaignMessageFields>(msg: T): T {
  const rest = { ...msg };
  delete rest.template_name;
  delete rest.template_language;
  delete rest.template_variable_map;
  return rest;
}

function templateLanguage(msg: CampaignMessageFields): string {
  return typeof msg.template_language === "string" && msg.template_language
    ? msg.template_language
    : "pt_BR";
}

/** Nomes de template das mensagens (para carregar o catálogo). */
export function campaignTemplateNames(mensagens: readonly CampaignMessageFields[]): string[] {
  return [
    ...new Set(
      mensagens
        .map((m) => (typeof m?.template_name === "string" ? m.template_name.trim() : ""))
        .filter(Boolean)
    ),
  ];
}

export interface MessageValidationOptions {
  /** "Mensagem" (sequência) ou "Template" (rotação/aleatório). */
  rotulo?: string;
}

/**
 * Problemas das mensagens para o provider da campanha. No Meta inclui a
 * checagem do template contra o catálogo local da WABA (`templateRows` =
 * linhas de wacrm.message_templates da conta com esses nomes).
 */
export function validateCampaignMessages(
  mensagens: readonly CampaignMessageFields[],
  provider: CampaignProvider,
  options: {
    wabaId?: string | null;
    templateRows?: readonly LocalTemplateRow[];
  } & MessageValidationOptions = {}
): string[] {
  const errors: string[] = [];
  if (mensagens.length === 0) return ["Adicione pelo menos uma mensagem."];
  if (provider !== "meta") return validateWahaMessages(mensagens, options.rotulo ?? "Mensagem");

  const rotulo = options.rotulo ?? "Mensagem";
  mensagens.forEach((m, i) => {
    const prefix = `${rotulo} #${i + 1}`;
    const tipo = m?.tipo ?? "texto";
    if (tipo !== "texto") {
      errors.push(
        `${prefix}: canais oficiais (Meta) só enviam template aprovado. Texto livre, IA, imagem, áudio e ligação são só para canais WAHA.`
      );
      return;
    }
    const name = typeof m?.template_name === "string" ? m.template_name.trim() : "";
    if (!name) {
      errors.push(`${prefix}: nos canais oficiais (Meta) toda mensagem precisa ser um template aprovado — escolha um template no passo Conteúdo.`);
      return;
    }
    if (!Array.isArray(m.template_variable_map)) {
      errors.push(`${prefix}: as variáveis do template "${name}" não foram mapeadas. Escolha o template de novo.`);
      return;
    }
    const result = validateCampaignTemplate({
      templateName: name,
      language: templateLanguage(m),
      mappedVariables: m.template_variable_map.length,
      rows: options.templateRows ?? [],
      wabaIds: options.wabaId ? [options.wabaId] : [],
    });
    if (!result.ok) errors.push(`${prefix}: ${result.error}`);
  });
  return errors;
}

// ---- WAHA (texto livre) ----
// Tipos aceitos nos canais WAHA. "ligacao" saiu do assistente (decisão de
// 06/10): campanha com ligação não é mais criada nem iniciada.
export const WAHA_MESSAGE_TYPES = ["texto", "ia", "imagem", "audio"] as const;
export type WahaMessageType = (typeof WAHA_MESSAGE_TYPES)[number];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Conteúdo mínimo de cada mensagem WAHA (o envio não tem template). */
function validateWahaMessages(mensagens: readonly CampaignMessageFields[], rotulo: string): string[] {
  const errors: string[] = [];
  mensagens.forEach((m, i) => {
    const prefix = `${rotulo} #${i + 1}`;
    const tipo = typeof m?.tipo === "string" && m.tipo ? m.tipo : "texto";
    if (tipo === "ligacao") {
      errors.push(`${prefix}: ligação não é mais enviada pelo disparador. Troque por texto, IA, imagem ou áudio.`);
      return;
    }
    if (!(WAHA_MESSAGE_TYPES as readonly string[]).includes(tipo)) {
      errors.push(`${prefix}: tipo de mensagem "${tipo}" não é suportado.`);
      return;
    }
    if (text(m.template_name)) {
      errors.push(`${prefix}: canais WAHA não enviam template da Meta. Escreva o texto da mensagem.`);
      return;
    }
    if (tipo === "texto" && !text(m.conteudo)) errors.push(`${prefix}: escreva o texto.`);
    if (tipo === "ia" && !text(m.prompt)) errors.push(`${prefix}: escreva o prompt da IA.`);
    if ((tipo === "imagem" || tipo === "audio") && !text(m.url)) {
      errors.push(`${prefix}: informe o arquivo (link ou upload) da ${tipo === "imagem" ? "imagem" : "mensagem de áudio"}.`);
    }
  });
  return errors;
}

// ---- Modo de templates (campaigns.dias_permitidos) ----
// A coluna jsonb legada dias_permitidos guarda o modo (ver startCampaign.ts).
// Regra única (assistente, POST, PATCH e startCampaign):
//   - "sequencia" = "Padrão" na tela. Meta: exatamente 1 template para
//     todos. WAHA: 1 mensagem, ou uma SEQUÊNCIA de várias partes (texto,
//     imagem, áudio…) enviadas em ordem para cada contato.
//   - "rotacao" / "aleatorio": 2 ou mais variações; cada contato recebe UMA
//     (alternada na ordem da lista, ou sorteada). Não há sequência nesses
//     modos — o motor já manda só 1 mensagem por contato.
export const TEMPLATE_MODES = ["sequencia", "rotacao", "aleatorio"] as const;
export type TemplateMode = (typeof TEMPLATE_MODES)[number];

/** Valor salvo → modo. Linhas antigas guardam o array [1..6] = "sequencia". */
export function parseTemplateMode(raw: unknown): TemplateMode {
  return raw === "rotacao" || raw === "aleatorio" ? raw : "sequencia";
}

export const TEMPLATE_MODE_LABELS: Record<TemplateMode, string> = {
  sequencia: "Padrão",
  rotacao: "Rotação",
  aleatorio: "Aleatório",
};

/** Mensagens que cada contato recebe no modo (para a estimativa). */
export function messagesPerContact(mode: TemplateMode, totalMessages: number): number {
  return mode === "sequencia" ? Math.max(1, totalMessages) : 1;
}

export function validateTemplateMode(
  mensagens: readonly CampaignMessageFields[],
  provider: CampaignProvider,
  mode: TemplateMode
): string[] {
  const n = mensagens.length;
  if (n === 0) return [];
  const itens = provider === "meta" ? "templates" : "mensagens";
  if (mode === "sequencia") {
    if (provider === "meta" && n !== 1) {
      return [
        `Modo Padrão usa exatamente 1 template para todos os contatos (há ${n}). Para usar mais de um, escolha Rotação ou Aleatório.`,
      ];
    }
    return [];
  }
  const nome = TEMPLATE_MODE_LABELS[mode];
  if (n < 2) return [`Modo ${nome} precisa de pelo menos 2 ${itens} diferentes (há ${n}).`];
  if (provider === "meta") {
    const keys = mensagens.map((m) => `${text(m.template_name)}|${templateLanguage(m)}`);
    if (new Set(keys).size !== keys.length) {
      return [`Modo ${nome}: o mesmo template foi escolhido mais de uma vez. Escolha templates diferentes.`];
    }
  }
  return [];
}

// ---- Variáveis (template_variable_map) ----
const CONTACT_FIELDS = ["name", "phone", "company", "cpf"];

/**
 * Fontes das variáveis: valor fixo preenchido, campo de contato conhecido e
 * coluna do CSV só quando a campanha tem base importada. `audienceMode`
 * null (campanha antiga) não bloqueia csv_var: a base pode existir.
 */
export function validateVariableSources(
  mensagens: readonly CampaignMessageFields[],
  audienceMode: string | null | undefined,
  rotulo = "Mensagem"
): string[] {
  const errors: string[] = [];
  const semBase = audienceMode === "tags" || audienceMode === "account";
  mensagens.forEach((m, i) => {
    if (!Array.isArray(m?.template_variable_map)) return;
    const prefix = `${rotulo} #${i + 1}`;
    (m.template_variable_map as unknown[]).forEach((raw, idx) => {
      const entry = (raw ?? {}) as { type?: unknown; value?: unknown; field?: unknown; index?: unknown };
      const n = `{{${idx + 1}}}`;
      if (entry.type === "static") {
        if (!text(entry.value)) errors.push(`${prefix}: ${n} está como valor fixo vazio — preencha o valor ou escolha outra fonte.`);
      } else if (entry.type === "contact_field") {
        if (!CONTACT_FIELDS.includes(String(entry.field))) errors.push(`${prefix}: ${n} usa um campo de contato desconhecido.`);
      } else if (entry.type === "csv_var") {
        if (![0, 1, 2].includes(Number(entry.index))) errors.push(`${prefix}: ${n} aponta para uma coluna do CSV inválida.`);
        else if (semBase) {
          errors.push(`${prefix}: ${n} usa uma coluna do CSV, mas a campanha não tem base importada. Escolha outra fonte.`);
        }
      } else if (entry.type !== "utm_link") {
        errors.push(`${prefix}: ${n} não tem fonte definida.`);
      }
    });
  });
  return errors;
}

export interface CampaignConfigInput {
  sessionIds: readonly string[];
  channels: readonly CampaignChannel[];
  mensagens: readonly CampaignMessageFields[];
  templateRows: readonly LocalTemplateRow[];
  /** Modo de templates salvo (dias_permitidos). Ausente = não confere. */
  templateMode?: TemplateMode;
  /** campaigns.audience_mode (para a regra das colunas do CSV). */
  audienceMode?: string | null;
}

export type CampaignConfigResult =
  | { ok: true; provider: CampaignProvider; wabaId: string | null }
  | { ok: false; error: string };

/** Todos os problemas de canais + mensagens + modo + variáveis. */
export function listCampaignConfigProblems(input: CampaignConfigInput): {
  channels: ChannelSelectionResult;
  problems: string[];
} {
  const channels = validateCampaignChannels(input.sessionIds, input.channels);
  if (!channels.ok) return { channels, problems: [channels.error] };
  const rotulo = input.templateMode && input.templateMode !== "sequencia" ? "Variação" : "Mensagem";
  const problems = [
    ...validateCampaignMessages(input.mensagens, channels.provider, {
      wabaId: channels.wabaId,
      templateRows: input.templateRows,
      rotulo,
    }),
    ...(input.templateMode ? validateTemplateMode(input.mensagens, channels.provider, input.templateMode) : []),
    ...validateVariableSources(input.mensagens, input.audienceMode, rotulo),
  ];
  return { channels, problems };
}

/** Canais + mensagens. Devolve o primeiro problema encontrado. */
export function validateCampaignConfig(input: CampaignConfigInput): CampaignConfigResult {
  const { channels, problems } = listCampaignConfigProblems(input);
  if (!channels.ok) return channels;
  if (problems.length > 0) return { ok: false, error: problems[0] };
  return { ok: true, provider: channels.provider, wabaId: channels.wabaId };
}

// ---- Configurações (agendamento, janela, ritmo, público) ----
// Conferidas na criação (POST) e na edição (PATCH). O startCampaign não as
// repete: no início o agendamento já passou, por definição.

export const BUSINESS_DAYS = [1, 2, 3, 4, 5] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Agendamento precisa estar pelo menos 1 min à frente (o cron roda 1×/min). */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

export interface CampaignSettingsInput {
  nome?: unknown;
  janela_inicio?: unknown;
  janela_fim?: unknown;
  dias_envio?: unknown;
  agendamento?: unknown;
  agendamento_fim?: unknown;
  batch_size?: unknown;
  batch_pause_seconds?: unknown;
  batch_percent?: unknown;
  intervalo_min?: unknown;
  intervalo_max?: unknown;
  audience_mode?: unknown;
  tags_filtro?: unknown;
  dias_permitidos?: unknown;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseInstant(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * Problemas das configurações da campanha. `now` injetável (testes).
 * `confirmAllContacts` = aceite explícito de enviar para a conta inteira.
 */
export function validateCampaignSettings(
  input: CampaignSettingsInput,
  options: { now?: Date; confirmAllContacts?: boolean; requireAudience?: boolean } = {}
): string[] {
  const errors: string[] = [];
  const now = (options.now ?? new Date()).getTime();
  const nome = text(input.nome);
  if (!nome) errors.push("Informe o nome da campanha.");
  else if (nome.length > 120) errors.push("O nome da campanha pode ter no máximo 120 caracteres.");

  const inicio = text(input.janela_inicio);
  const fim = text(input.janela_fim);
  if (!HHMM.test(inicio) || !HHMM.test(fim)) {
    errors.push("Informe a hora inicial e a hora final no formato HH:MM.");
  } else if (fim <= inicio) {
    errors.push("A hora final precisa ser depois da hora inicial (o envio acontece dentro do mesmo dia).");
  }

  if (input.dias_envio != null) {
    const dias = input.dias_envio;
    if (!Array.isArray(dias) || dias.length === 0 || dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      errors.push("Dias de envio inválidos.");
    }
  }

  const agendamento = input.agendamento == null || input.agendamento === "" ? null : parseInstant(input.agendamento);
  if (input.agendamento != null && input.agendamento !== "" && agendamento === null) {
    errors.push("Data inicial inválida.");
  } else if (agendamento !== null && agendamento < now + MIN_SCHEDULE_LEAD_MS) {
    errors.push("A data e hora inicial precisam estar no futuro (pelo menos 1 minuto à frente).");
  }
  if (input.agendamento_fim != null && input.agendamento_fim !== "") {
    const fimAt = parseInstant(input.agendamento_fim);
    if (fimAt === null) errors.push("Data final inválida.");
    else if (agendamento !== null && fimAt <= agendamento) {
      errors.push("A data e hora final precisam ser depois da data e hora inicial.");
    }
  }

  const batchSize = input.batch_size;
  if (
    batchSize != null &&
    (!isFiniteNumber(batchSize) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 999_999)
  ) {
    errors.push("Tamanho de lote inválido.");
  }
  const pause = input.batch_pause_seconds;
  if (pause != null && (!isFiniteNumber(pause) || !Number.isInteger(pause) || pause < 0 || pause > 86_400)) {
    errors.push("O intervalo entre rodadas precisa ficar entre 0 e 24 h.");
  }
  const percent = input.batch_percent;
  if (percent != null && (!isFiniteNumber(percent) || percent < 1 || percent > 50)) {
    errors.push("No modo Segmentado, a rodada precisa ser de 1% a 50% da base.");
  }
  if (percent != null && isFiniteNumber(pause) && pause < 60) {
    errors.push("No modo Segmentado, o intervalo entre rodadas precisa ser de pelo menos 1 minuto.");
  }
  const imin = input.intervalo_min;
  const imax = input.intervalo_max;
  if (imin != null && (!isFiniteNumber(imin) || imin < 0 || imin > 86_400)) errors.push("Intervalo mínimo inválido.");
  if (imax != null && (!isFiniteNumber(imax) || imax < 0 || imax > 86_400)) errors.push("Intervalo máximo inválido.");
  if (isFiniteNumber(imin) && isFiniteNumber(imax) && imin > imax) {
    errors.push("O intervalo mínimo não pode ser maior que o máximo.");
  }

  if (input.dias_permitidos != null && !(TEMPLATE_MODES as readonly unknown[]).includes(input.dias_permitidos)) {
    errors.push("Modo de templates inválido.");
  }

  const audience = input.audience_mode;
  if (audience != null && audience !== "csv" && audience !== "tags" && audience !== "account") {
    errors.push("Origem do público inválida.");
  } else if (audience == null && options.requireAudience) {
    errors.push("Defina o público: importe uma base, escolha uma tabulação ou confirme a conta inteira.");
  } else if (audience === "tags" && Array.isArray(input.tags_filtro) && input.tags_filtro.length === 0) {
    errors.push("Público por tabulação: escolha pelo menos uma tabulação.");
  } else if (audience === "account" && options.requireAudience && !options.confirmAllContacts) {
    errors.push("Sem base importada e sem tabulação: confirme o envio para todos os contatos da conta.");
  }
  return errors;
}

/** Status decidido no servidor: com agendamento → agendado; sem → rascunho. */
export function decideCampaignStatus(agendamento: unknown): "agendado" | "rascunho" {
  return typeof agendamento === "string" && agendamento ? "agendado" : "rascunho";
}

/**
 * Texto de campaigns.motivo_falha_inicio (migration 160): a campanha volta
 * a rascunho quando o início falha, e o card mostra por quê.
 */
export function formatStartFailureReason(error: string, agendamento?: string | null): string {
  const quando = agendamento ? formatBrasilia(agendamento) : "";
  const prefixo = quando
    ? `O início agendado para ${quando} (Brasília) falhou e a campanha voltou para rascunho`
    : "O início falhou e a campanha voltou para rascunho";
  return `${prefixo}: ${error.trim() || "erro desconhecido"}`.slice(0, 1000);
}
