// Trava anti-loop (responder.ts): detecta o NOSSO bot em loop — tipicamente
// conversando com outro robô (URA, autoresposta de empresa) que responde na
// hora a cada mensagem.
//
// Antes: "6 mensagens (de qualquer lado) em menos de 12 s" usando
// created_at, que nas mensagens do cliente é o relógio do PROVEDOR. Cliente
// mandando várias fotos do boleto ou quebrando a frase em várias mensagens
// caía na trava e ia para humano (C6 do PRD 01).
//
// Agora: conta só mensagens do BOT (sender_type "bot") na janela, pelo
// horário do NOSSO servidor (received_at, DEFAULT now() no INSERT —
// migration 043). O cliente mandar muitas mensagens não dispara nada; o
// bot só passa de BOT_LOOP_MIN_MESSAGES em BOT_LOOP_WINDOW_SECONDS se
// estiver respondendo a outra máquina (cada resposta nossa leva debounce
// + modelo, ~8-12 s; uma conversa humana normal fica bem abaixo disso,
// mesmo com boleto/PIX em mensagens separadas).

/** Mensagens do bot na janela para considerar loop. */
export const BOT_LOOP_MIN_MESSAGES = 8;
/** Janela (relógio do servidor). */
export const BOT_LOOP_WINDOW_SECONDS = 120;

export interface BotLoopMatch {
  /** Mensagens do bot dentro da janela. */
  botMessages: number;
  /** Segundos entre a mais antiga e a mais nova delas. */
  windowSeconds: number;
}

/**
 * `botReceivedAt` = received_at das mensagens do BOT mais recentes (qualquer
 * ordem). null = sem loop.
 */
export function detectBotLoop(
  botReceivedAt: Array<string | null | undefined>,
  now: Date = new Date(),
  // Perfil de agente (Fase 4) pode ajustar a trava; sem opções valem as constantes de sempre.
  options: { minMessages?: number; windowSeconds?: number; futureToleranceMs?: number } = {},
): BotLoopMatch | null {
  const minMessages = options.minMessages ?? BOT_LOOP_MIN_MESSAGES;
  const windowSeconds = options.windowSeconds ?? BOT_LOOP_WINDOW_SECONDS;
  const futureToleranceMs = options.futureToleranceMs ?? 5_000;
  const since = now.getTime() - windowSeconds * 1000;
  const times = botReceivedAt
    .map((v) => (v ? new Date(v).getTime() : Number.NaN))
    .filter((t) => Number.isFinite(t) && t >= since && t <= now.getTime() + futureToleranceMs)
    .sort((a, b) => a - b);
  if (times.length < minMessages) return null;
  return {
    botMessages: times.length,
    windowSeconds: Math.round((times[times.length - 1] - times[0]) / 1000),
  };
}
