// Equipe → canais → templates no assistente "Nova campanha" (passo Origem).
// Funções puras, sem I/O. A regra de canais válidos continua em
// campaign-validation.ts (validateCampaignChannels); aqui fica só o que a
// tela oferece e o que ela tira da seleção.

import type { CampaignChannel } from "@/lib/disparador/campaign-validation";

export interface WizardChannel extends CampaignChannel {
  /** whatsapp_config.team_id (migration 103); null = canal sem equipe. */
  team_id?: string | null;
}

/** Canais que a tela oferece: habilitados e da equipe ("" = todas). */
export function channelsForTeam<T extends WizardChannel>(channels: readonly T[], teamId: string): T[] {
  return channels.filter((c) => c.habilitado !== false && (!teamId || c.team_id === teamId));
}

/**
 * Trocar a equipe tira da seleção os canais que ficaram de fora (antes eles
 * só sumiam da tela e continuavam selecionados) e os desabilitados.
 */
export function keepChannelsInTeam(
  selectedIds: readonly string[],
  channels: readonly WizardChannel[],
  teamId: string
): string[] {
  const allowed = new Set(channelsForTeam(channels, teamId).map((c) => c.id));
  return selectedIds.filter((id) => allowed.has(id));
}

/** Equipe comum a todos os canais selecionados (edição), ou "" se não houver. */
export function inferTeamFromChannels(selectedIds: readonly string[], channels: readonly WizardChannel[]): string {
  const teams = new Set(
    channels.filter((c) => selectedIds.includes(c.id)).map((c) => c.team_id ?? "")
  );
  if (teams.size !== 1) return "";
  return [...teams][0];
}

export type ChannelOptionState = { disabled: false } | { disabled: true; reason: string };

/**
 * Por que um canal não pode entrar na seleção atual: um provedor por
 * campanha (Meta ou WAHA) e, na Meta, uma única WABA. O primeiro canal
 * escolhido define o grupo; os outros grupos ficam desabilitados com o
 * motivo. Canal já selecionado nunca fica desabilitado (dá para desmarcar).
 */
export function channelOptionState(
  channel: WizardChannel,
  selectedIds: readonly string[],
  channels: readonly WizardChannel[]
): ChannelOptionState {
  if (selectedIds.includes(channel.id)) return { disabled: false };
  if (channel.provider === "meta" && !channel.waba_id) {
    return { disabled: true, reason: "Número sem conta WhatsApp Business (WABA) configurada — reconecte em Canais." };
  }
  const selected = channels.filter((c) => selectedIds.includes(c.id));
  if (selected.length === 0) return { disabled: false };
  const first = selected[0];
  const firstIsMeta = first.provider === "meta";
  const isMeta = channel.provider === "meta";
  if (firstIsMeta !== isMeta) {
    return {
      disabled: true,
      reason: firstIsMeta
        ? "A campanha já usa número oficial (Meta). Canais WAHA ficam para outra campanha."
        : "A campanha já usa sessão WAHA. Números oficiais (Meta) ficam para outra campanha.",
    };
  }
  if (isMeta && first.waba_id !== channel.waba_id) {
    return {
      disabled: true,
      reason: "Número de outra conta WhatsApp Business (WABA). Uma campanha Meta usa uma única WABA.",
    };
  }
  return { disabled: false };
}

/**
 * Templates liberados para a equipe (team_allowed_templates, migration 106).
 * `allowedIds` null ou vazio = equipe sem restrição cadastrada → todos.
 */
export function filterTemplatesForTeam<T extends { id: string }>(
  templates: readonly T[],
  allowedIds: ReadonlySet<string> | null
): T[] {
  if (!allowedIds || allowedIds.size === 0) return [...templates];
  return templates.filter((t) => allowedIds.has(t.id));
}
