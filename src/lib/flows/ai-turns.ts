// Regras de turno dos nós ai_agent (engine.ts), isoladas para teste.
//
// 1. Estacionar antes do próximo ai_agent (parkBeforeAiAgent)
//    Um nó ai_agent em loop que sai (tag ou max_turns) e JÁ respondeu ao
//    cliente "consumiu" a mensagem dele. Se o walk síncrono — passando por
//    switch/condição/set_var etc. — chega a OUTRO ai_agent em loop, esse
//    nó não pode rodar com a MESMA mensagem: a resposta seria para uma
//    pergunta que o cliente ainda não respondeu. Caso real: agente_ddm
//    pergunta "o que pesa mais…?" + #RECUSA → switch_resultado →
//    recovery_recusa rodava na hora, decidia sem resposta do cliente e
//    terminava em handoff_fallback (C3 do PRD 01). Agora o run estaciona
//    no nó e a PRÓXIMA mensagem do cliente o dispara
//    (handleReplyForActiveRun).
//    Não estaciona quando a IA que saiu não mandou nada ao cliente
//    (ex.: BEN emite só #NEGOCIACAO e o Aleh precisa responder na hora) —
//    aí o cliente ficaria sem resposta. Nem quando o próximo nó é
//    once/takeover (esses não ficam estacionados em si mesmos).
//
// 2. Turnos que não contam para max_turns (isTurnFreeInbound)
//    Mídia sem texto (foto, figurinha, vídeo, documento) e confirmação
//    pura ("ok", "👍", "obrigado") não gastam turno de __ai_turns__ —
//    antes cada foto do boleto ou "ok" consumia um turno e a conversa
//    esgotava max_turns e ia para humano. Conservador: "sim", "certo",
//    "blz" contam (podem ser resposta de verdade), áudio conta (é
//    transcrito e respondido como texto) e no máximo
//    MAX_FREE_AI_TURNS turnos grátis por passagem no nó.

import type { AiAgentNodeConfig } from "./types";

/** Contexto do walk síncrono disparado por UMA mensagem do cliente. */
export interface AdvanceWalkContext {
  /**
   * true = um ai_agent em loop já saiu NESTE walk e enviou resposta ao
   * cliente para a mensagem que disparou o walk.
   */
  inboundAnsweredByAi?: boolean;
}

/** Estaciona (espera a próxima mensagem) em vez de rodar o ai_agent agora? */
export function parkBeforeAiAgent(
  nodeConfig: Pick<AiAgentNodeConfig, "mode"> | null | undefined,
  ctx: AdvanceWalkContext | undefined,
): boolean {
  return ctx?.inboundAnsweredByAi === true && nodeConfig?.mode === "loop";
}

/** Máximo de turnos "grátis" (mídia/ok) por passagem no nó. */
export const MAX_FREE_AI_TURNS = 3;

const FREE_MEDIA_TYPES = new Set(["image", "sticker", "video", "document"]);

// Palavras de confirmação pura. "sim", "certo", "blz", "beleza" ficam de
// fora de propósito: podem ser a resposta a uma pergunta da IA.
const ACK_WORDS = new Set(["ok", "okay", "okk", "okok", "obrigado", "obrigada", "obg", "muito"]);

/** Mensagem do cliente que não consome turno de max_turns. */
export function isTurnFreeInbound(
  text: string | null | undefined,
  contentType: string | null | undefined,
): boolean {
  const raw = (text ?? "").trim();
  if (!raw) {
    // Sem texto: só mídia que não é áudio (áudio vira texto via Whisper).
    return !!contentType && FREE_MEDIA_TYPES.has(contentType);
  }
  const normalized = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  // Só emoji/pontuação (👍, 🙏, "!!") = confirmação.
  if (words.length === 0) return /\p{Extended_Pictographic}/u.test(raw);
  return words.every((w) => ACK_WORDS.has(w)) && words.some((w) => w !== "muito");
}

export interface AiTurnCount {
  /** Valor novo de __ai_turns__. */
  turns: number;
  /** Valor novo de __ai_free_turns__. */
  freeTurns: number;
  /** Este turno foi isento (não contou para max_turns). */
  free: boolean;
}

/** Próximo contador de turnos — isento só até MAX_FREE_AI_TURNS. */
export function nextAiTurnCount(
  priorTurns: number,
  priorFreeTurns: number,
  inboundIsFree: boolean,
): AiTurnCount {
  if (inboundIsFree && priorFreeTurns < MAX_FREE_AI_TURNS) {
    return { turns: priorTurns, freeTurns: priorFreeTurns + 1, free: true };
  }
  return { turns: priorTurns + 1, freeTurns: priorFreeTurns, free: false };
}

/** Lê um contador numérico de run.vars (0 quando ausente/inválido). */
export function readTurnVar(vars: Record<string, unknown> | null | undefined, key: string): number {
  const v = vars?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
