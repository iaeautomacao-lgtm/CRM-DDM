// Disparo da análise de sentimento a partir das mensagens recebidas
// (webhooks Meta/WAHA, Instagram/Messenger e Webchat).
//
// Antes a análise só rodava quando nenhum fluxo tinha tratado a mensagem
// e nunca nos canais sociais/Webchat — numa conta em que quase tudo passa
// por fluxo, o sentimento ficava "sem análise" até alguém clicar em
// atualizar no Inbox. Agora:
//   - roda em todos os canais;
//   - com fluxo ativo, só quando a mensagem é texto "de conversa" (não um
//     toque em botão/menu como "1" ou "Sim");
//   - espera alguns segundos e roda uma vez por rajada: o cliente que
//     manda 4 mensagens seguidas gera 1 chamada à IA, com o histórico
//     completo, em vez de 4 fora de ordem.
//
// O timer vive na memória do processo: um restart no meio da espera só
// perde aquela análise (a próxima mensagem ou o botão de atualizar
// refazem) — nada recorrente depende dele.

export const SENTIMENT_DEBOUNCE_MS = 8_000;

interface SentimentInbound {
  text: string | null | undefined;
  /** O fluxo tratou esta mensagem (menu, coleta, IA do fluxo…). */
  flowConsumed: boolean;
  /** Resposta de botão/lista interativa. */
  isInteractiveReply?: boolean;
}

/** Vale chamar a IA para esta mensagem? */
export function shouldAnalyzeSentiment(msg: SentimentInbound): boolean {
  const text = (msg.text ?? "").trim();
  if (!text) return false;
  if (!msg.flowConsumed) return true;
  if (msg.isInteractiveReply) return false;
  // Com fluxo: ignora escolhas de menu ("1", "2.", "sim", "ok").
  if (/^\d{1,3}[.)]?$/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 3 || text.length >= 15;
}

type Timers = Map<string, ReturnType<typeof setTimeout>>;
const globalForSentiment = globalThis as unknown as { __sentimentTimers?: Timers };
const timers: Timers = (globalForSentiment.__sentimentTimers ??= new Map());

/**
 * Agenda a análise da conversa; mensagens novas dentro da janela
 * reiniciam a espera (só a última dispara). Nunca lança.
 */
export function scheduleSentimentAnalysis(
  accountId: string,
  contactId: string,
  conversationId: string,
  delayMs = SENTIMENT_DEBOUNCE_MS,
): void {
  const pending = timers.get(conversationId);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    timers.delete(conversationId);
    void import("./sentiment")
      .then(({ analyzeConversationSentimentAndTags }) =>
        analyzeConversationSentimentAndTags(accountId, contactId, conversationId),
      )
      .catch((err) => console.error("[sentiment] análise falhou:", err));
  }, delayMs);
  // Não segura o processo vivo só por causa da espera.
  timer.unref?.();
  timers.set(conversationId, timer);
}

/** Atalho usado pelos webhooks: decide e agenda. */
export function maybeScheduleSentiment(
  ids: { accountId: string; contactId: string; conversationId: string },
  msg: SentimentInbound,
): void {
  if (!shouldAnalyzeSentiment(msg)) return;
  scheduleSentimentAnalysis(ids.accountId, ids.contactId, ids.conversationId);
}
