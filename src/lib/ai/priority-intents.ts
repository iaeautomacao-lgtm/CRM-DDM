export type PriorityIntentKind =
  | "opt_out"
  | "wrong_person"
  | "human_request"
  | "contestation";

export interface PriorityIntent {
  kind: PriorityIntentKind;
  tag: "#OPT_OUT" | "#CONTATO_DIVERGENTE" | "#CLIENTE_PEDIU_HUMANO" | "#CONTESTACAO_DIVIDA";
  reply: string;
}

function normalize(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const OPT_OUT_PATTERNS = [
  /\bnao (?:quero|desejo) (?:mais )?(?:receber|mensagens?|contato)\b/,
  /\b(?:pare|para) de (?:me )?(?:mandar|enviar) (?:mensagens?|msg)\b/,
  /\bnao (?:me )?(?:mande|envie|mandar|enviar|receber) mais (?:mensagens?|msg|contato)?\b/,
  /\bnao (?:me )?(?:mandar|enviar|receber) mais\b/,
  /\b(?:remova|retire) (?:meu )?(?:numero|contato)\b/,
  /\bnao entre mais em contato\b/,
];

const WRONG_PERSON_PATTERNS = [
  /\bnao sou (?:a|o|essa|esse|esta|este)?\s*[a-z]/,
  /\bnao me chamo\b/,
  /\bnumero errado\b/,
  /\besse numero nao e (?:meu|dela|dele)\b/,
  /\bvoces? enviaram errado\b/,
  /\bmandaram (?:a mensagem )?para (?:a )?pessoa errada\b/,
];

const HUMAN_REQUEST_PATTERNS = [
  /\b(?:quero|preciso|prefiro) (?:falar com )?(?:um |uma )?(?:atendente|humano|pessoa)\b/,
  /\b(?:falar|fala) com (?:um |uma )?(?:atendente|humano|pessoa)\b/,
  /\bme (?:transfira|encaminhe) (?:para )?(?:um |uma )?(?:atendente|humano|pessoa|equipe)\b/,
];

const CONTESTATION_PATTERNS = [
  /\bja (?:paguei|foi pago|quitei|resolvi|negociei|acertei)\b/,
  /\b(?:paguei|quitei) (?:hoje|ontem|essa|esta)\b/,
  /\bnao reconheco (?:a |essa |esta )?(?:divida|pendencia|cobranca)\b/,
  /\bnao devo\b/,
  /\bdebito indevido\b/,
  /\b(?:valor|cobranca|divida|debito) (?:esta|ta) errado\b/,
  /\btranquei (?:o curso |a matricula )?(?:antes|faz tempo)?\b/,
  /\bcancelei (?:o curso|a matricula)\b/,
];

export function classifyPriorityIntent(input: string): PriorityIntent | null {
  const text = normalize(input || "");
  if (!text) return null;

  if (
    text === "stop" ||
    text === "sair" ||
    OPT_OUT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return {
      kind: "opt_out",
      tag: "#OPT_OUT",
      reply:
        "Entendido. Registrei sua solicitação e você não receberá novas mensagens de cobrança por este canal.",
    };
  }

  if (WRONG_PERSON_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      kind: "wrong_person",
      tag: "#CONTATO_DIVERGENTE",
      reply:
        "Peço desculpas pelo contato incorreto. Vou encaminhar para nossa equipe revisar o cadastro e evitar novas cobranças indevidas neste número.",
    };
  }

  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      kind: "human_request",
      tag: "#CLIENTE_PEDIU_HUMANO",
      reply: "Claro. Vou encaminhar seu atendimento para nossa equipe agora. Um momento, por favor.",
    };
  }

  if (CONTESTATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      kind: "contestation",
      tag: "#CONTESTACAO_DIVIDA",
      reply:
        "Entendo. Como você informou que o débito já foi pago, resolvido ou não corresponde à sua situação, vou encaminhar o caso para nossa equipe verificar antes de qualquer nova negociação.",
    };
  }

  return null;
}
