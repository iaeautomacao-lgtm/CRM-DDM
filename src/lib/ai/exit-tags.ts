/**
 * Tags de saída conhecidas (control-plane da IA). Só elas — mais as tags
 * que o próprio fluxo usa nos ramos do switch (ver `flowExitTagsFromNodes`
 * em flows/engine.ts) — são tratadas como tag. Antes qualquer `#XXX`
 * virava tag: "opção #2", "boleto #123" ou "#DDM" iam para o default do
 * switch e a conversa caía no humano.
 */
export const KNOWN_AI_EXIT_TAGS: readonly string[] = [
  "#ACORDOFORMALIZADO",
  "#EQUIPEHUMANA",
  "#RECUSA",
  "#RECUSA_CONFIRMADA",
  "#RECUPERADO",
  "#AGENDAMENTO",
  "#NAOENVIACPF",
  "#INSTABILIDADE",
  "#CLIENTE_PEDIU_HUMANO",
  "#CPF_NAO_LOCALIZADO",
  "#CPF_INVALIDO",
  "#ACORDO_EXISTENTE",
  "#ERRO_EFETIVACAO",
  "#CONTESTACAO_DIVIDA",
  "#FALLBACK_EXAURIDO",
  "#OPT_OUT",
  "#CONTATO_DIVERGENTE",
  // Legadas (prompts antigos / responder fora de fluxo).
  "#NEGOCIACAO",
  "#ANIMA",
  "#NAOLOCALIZADO",
];

const KNOWN_TAG_SET = new Set(KNOWN_AI_EXIT_TAGS);

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
  "#OPT_OUT",
  "#CONTATO_DIVERGENTE",
]);

// Token candidato: # + letra maiúscula + [A-Z0-9_]. Não casa "#2"/"#123".
const TAG_TOKEN = /#[A-Z][A-Z0-9_]*/g;

/**
 * Normaliza uma tag configurada no fluxo ("RECUSA", "#recusa") para o
 * formato canônico "#RECUSA". Devolve null se não parece tag.
 */
export function normalizeExitTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  const tag = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[A-Z][A-Z0-9_]*$/.test(tag) ? tag : null;
}

function isAcceptedTag(tag: string, extraTags?: Iterable<string>): boolean {
  if (KNOWN_TAG_SET.has(tag)) return true;
  if (!extraTags) return false;
  for (const extra of extraTags) {
    if (normalizeExitTag(extra) === tag) return true;
  }
  return false;
}

/**
 * Tag de saída da resposta da IA: só tags conhecidas (ou as usadas pelo
 * fluxo, em `extraTags`); havendo mais de uma, vale a ÚLTIMA (o modelo
 * fecha a resposta com a decisão final).
 */
export function extractAiExitTag(
  text: string,
  extraTags?: Iterable<string>,
): string | null {
  let found: string | null = null;
  for (const match of text.matchAll(TAG_TOKEN)) {
    if (isAcceptedTag(match[0], extraTags)) found = match[0];
  }
  return found;
}

/**
 * Remove do texto enviado ao cliente TODAS as tags aceitas (não só a
 * detectada), inclusive o sufixo legado "(finalização)". Tags que não
 * são de controle ("opção #2", "#DDM") ficam no texto.
 */
export function stripAiExitTag(
  text: string,
  tag: string | null,
  extraTags?: Iterable<string>,
): string {
  const extras = [...(extraTags ?? []), ...(tag ? [tag] : [])];
  return text
    .replace(/#[A-Z][A-Z0-9_]*(?:\(finaliza(?:ç|c)(?:ã|a)o\))?/g, (token) => {
      const bare = token.replace(/\(.*\)$/, "");
      return isAcceptedTag(bare, extras) ? "" : token;
    })
    .replace(/[ \t]+$/gm, "")
    .trim();
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
