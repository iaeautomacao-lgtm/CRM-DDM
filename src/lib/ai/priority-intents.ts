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

// "não sou …" só conta como pessoa errada com artigo/demonstrativo + nome
// ou "pessoa": "não sou capaz de pagar", "não sou obrigado", "não sou de
// fugir" e "não sou o tipo de…" seguem para a IA (antes viravam
// #CONTATO_DIVERGENTE e iam para humano).
const NOT_A_NAME_AFTER_ARTICLE =
  "(?:tipo|favor|unic[oa]|culpad[oa]|mesm[oa]|melhor|pior|primeir[oa]|ultim[oa]|responsavel|devedor|devedora|caloteir[oa]|obrigad[oa])";

const WRONG_PERSON_PATTERNS = [
  /\bnao sou (?:essa|esse|esta|este) (?:pessoa|cliente|senhor|senhora|moca|moco|rapaz|mulher|homem)\b/,
  /\bnao sou (?:a|o) (?:pessoa|cliente|titular|dono|dona)\b/,
  new RegExp(`\\bnao sou (?:a|o) (?!${NOT_A_NAME_AFTER_ARTICLE}\\b)[a-z]{3,}\\b`),
  /\bnao sou (?:ele|ela)\b/,
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
  /\bja (?:paguei|pagamos|foi pag[oa]|esta pag[oa]|ta pag[oa]|quitei|quitamos|resolvi|resolvemos|negociei|negociamos|acertei|acertamos)\b/,
  /\b(?:paguei|pagamos|quitei|quitamos) (?:hoje|ontem|essa|esta)\b/,
  /\bnao reconheco (?:a |essa |esta )?(?:divida|pendencia|cobranca)\b/,
  // "não devo" só como negação da dívida ("não devo nada", "eu não devo
  // isso", "não devo!") — "não devo conseguir pagar este mês" segue para a IA.
  /\bnao devo (?:nada|isso|isto|esse|essa|este|esta|nenhum|nenhuma|mais nada|a voces|pra voces|para voces)\b/,
  /\bnao devo\s*(?:[.!?,;]|$)/,
  /\bdebito indevido\b/,
  /\b(?:valor|cobranca|divida|debito) (?:esta|ta) errado\b/,
  // Trancamento só conta como contestação com indicação de que foi antes
  // da cobrança — "tranquei a matrícula mas quero negociar" segue para a IA.
  /\btranquei (?:o curso |a matricula |a faculdade )?(?:antes|faz (?:muito )?tempo|ha (?:muito )?tempo|ha \d+ anos?|em \d{4})\b/,
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
