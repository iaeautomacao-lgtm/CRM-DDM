// Trava anti-xingamento / anti-jailbreak (responder.ts): decide, sem
// chamar o modelo, se a mensagem do cliente é ofensa ou tentativa clara de
// "quebrar" o agente.
//
// Antes a checagem era `texto.includes(palavra)`, sem fronteira de palavra,
// e a lista tinha termos comuns em cobrança. Falsos positivos reais:
// "comprovante env-IADO" (viado), "com-PUTA-dor"/"dis-PUTA" (puta),
// "consta no SISTEMA", "BOTão", "MÁQUINA de cartão". Agora:
//   - texto sem acento, minúsculo, só palavra/frase INTEIRA;
//   - fora da lista: sistema, máquina, bot, robô, prompt, inteligência
//     artificial, chatgpt, gemini (cliente perguntando "é robô?" ou "é o
//     ChatGPT?" não é ataque) e "sacanagem" (reclamação comum: "que
//     sacanagem esses juros");
//   - jailbreak só com frase explícita ("ignore as instruções", "system
//     prompt", "jailbreak").

export type AbuseKind = "offense" | "jailbreak";

export interface AbuseMatch {
  kind: AbuseKind;
  /** Termo (normalizado) que disparou a trava — vai para a telemetria. */
  term: string;
}

const OFFENSE_TERMS = [
  "fudido",
  "fodido",
  "corno",
  "puta",
  "viado",
  "caralho",
  "bosta",
  "merda",
  "vsf",
  "vtnc",
  "tnc",
  "fdp",
  "otario",
  "imbecil",
  "idiota",
  "palhaco",
  "vai se foder",
  "vai se fuder",
  "vai tomar no cu",
  "tomar no cu",
  "tomar no c",
];

const JAILBREAK_TERMS = [
  "jailbreak",
  "ignore instructions",
  "ignore previous instructions",
  "ignore all previous instructions",
  "ignore your instructions",
  "ignorar instrucoes",
  "ignorar as instrucoes",
  "ignore as instrucoes",
  "ignore suas instrucoes",
  "ignore todas as instrucoes",
  "esqueca suas instrucoes",
  "esqueca as instrucoes",
  "system prompt",
  "prompt do sistema",
];

/** Sem acento, minúsculo, pontuação vira espaço, espaços colapsados. */
export function normalizeForAbuseCheck(input: string): string {
  return (input || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsWholeTerm(paddedText: string, term: string): boolean {
  return paddedText.includes(` ${term} `);
}

/**
 * Ofensa ou jailbreak explícito na mensagem; null = segue para a IA.
 * Jailbreak tem prioridade (é o caso de gasto de token proposital).
 */
export function detectAbusiveInput(input: string): AbuseMatch | null {
  const normalized = normalizeForAbuseCheck(input);
  if (!normalized) return null;
  const padded = ` ${normalized} `;
  const jailbreak = JAILBREAK_TERMS.find((term) => containsWholeTerm(padded, term));
  if (jailbreak) return { kind: "jailbreak", term: jailbreak };
  const offense = OFFENSE_TERMS.find((term) => containsWholeTerm(padded, term));
  if (offense) return { kind: "offense", term: offense };
  return null;
}
