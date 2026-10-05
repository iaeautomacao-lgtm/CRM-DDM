const LEGACY_HUMAN_TRANSFER_TAGS = new Set([
  "#EQUIPEHUMANA",
  "#RECUSA",
  "#RECUSA_CONFIRMADA",
  "#NEGOCIACAO",
  "#ANIMA",
  "#AGENDAMENTO",
  "#NAOLOCALIZADO",
  "#NAOENVIACPF",
  "#INSTABILIDADE",
  "#CLIENTE_PEDIU_HUMANO",
  "#CPF_NAO_LOCALIZADO",
  "#CPF_INVALIDO",
  "#ACORDO_EXISTENTE",
  "#ERRO_EFETIVACAO",
  "#CONTESTACAO_DIVIDA",
  "#FALLBACK_EXAURIDO",
]);

export function extractAiExitTag(text: string): string | null {
  const match = text.match(/#[A-Z0-9_]+/);
  return match ? match[0] : null;
}

export function stripAiExitTag(text: string, tag: string | null): string {
  if (!tag) return text.trim();
  return text.split(tag).join("").trim();
}

export function shouldLegacyAssignHuman(input: {
  tag: string | null;
  flowControlled: boolean;
  hasAgreedAcordo: boolean;
}): boolean {
  if (input.flowControlled) return false;
  if (input.hasAgreedAcordo) return true;
  return input.tag ? LEGACY_HUMAN_TRANSFER_TAGS.has(input.tag) : false;
}
