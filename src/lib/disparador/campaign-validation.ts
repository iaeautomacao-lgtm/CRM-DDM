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
  if (provider !== "meta") return errors;

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
      errors.push(`${prefix}: nos canais oficiais (Meta) toda mensagem precisa ser um template aprovado — use "Carregar de um Template".`);
      return;
    }
    if (!Array.isArray(m.template_variable_map)) {
      errors.push(`${prefix}: as variáveis do template "${name}" não foram mapeadas. Carregue o template de novo.`);
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

export interface CampaignConfigInput {
  sessionIds: readonly string[];
  channels: readonly CampaignChannel[];
  mensagens: readonly CampaignMessageFields[];
  templateRows: readonly LocalTemplateRow[];
}

export type CampaignConfigResult =
  | { ok: true; provider: CampaignProvider; wabaId: string | null }
  | { ok: false; error: string };

/** Canais + mensagens. Devolve o primeiro problema encontrado. */
export function validateCampaignConfig(input: CampaignConfigInput): CampaignConfigResult {
  const channels = validateCampaignChannels(input.sessionIds, input.channels);
  if (!channels.ok) return channels;
  const problems = validateCampaignMessages(input.mensagens, channels.provider, {
    wabaId: channels.wabaId,
    templateRows: input.templateRows,
  });
  if (problems.length > 0) return { ok: false, error: problems[0] };
  return { ok: true, provider: channels.provider, wabaId: channels.wabaId };
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
