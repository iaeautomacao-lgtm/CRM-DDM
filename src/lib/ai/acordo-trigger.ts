// Disparo do classificador "Acordo Realizado" (acordo-tagging.ts) a partir
// das mensagens recebidas fora de fluxo (webhooks Meta e WAHA).
//
// Antes rodava uma chamada à IA a cada mensagem recebida. Agora segue o
// mesmo debounce do sentimento (sentiment-trigger.ts): espera alguns
// segundos e roda uma vez por rajada, com o histórico completo; e o
// próprio classificador pula a mensagem já analisada (cache por última
// mensagem em conversations.outcome_suggestion_key).
//
// O timer vive na memória do processo: um restart no meio da espera só
// perde aquela análise (a próxima mensagem refaz). No Passenger, timers
// não são compartilhados entre workers e se perdem no restart; limitação
// aceita para esta sugestão best-effort — nada recorrente depende dele.

export const ACORDO_DEBOUNCE_MS = 15_000;

type Timers = Map<string, ReturnType<typeof setTimeout>>;
const globalForAcordo = globalThis as unknown as { __acordoTimers?: Timers };
const timers: Timers = (globalForAcordo.__acordoTimers ??= new Map());

/**
 * Agenda a classificação da conversa; mensagens novas dentro da janela
 * reiniciam a espera (só a última dispara). Nunca lança.
 */
export function scheduleAcordoSuggestion(
  accountId: string,
  conversationId: string,
  delayMs = ACORDO_DEBOUNCE_MS,
): void {
  const pending = timers.get(conversationId);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    timers.delete(conversationId);
    void import("./acordo-tagging")
      .then(({ suggestAcordoRealizado }) => suggestAcordoRealizado(accountId, conversationId))
      .catch((err) => console.error("[acordo] classificação falhou:", err));
  }, delayMs);
  // Não segura o processo vivo só por causa da espera.
  timer.unref?.();
  timers.set(conversationId, timer);
}
