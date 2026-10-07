export const QUEUE_DETAIL_STATUS_FILTERS: Record<string, string[]> = {
  // "A enviar" representa todo trabalho ainda não concluído da campanha.
  // Ao pausar, a RPC move agendado/pendente -> pausado; portanto pausado
  // precisa continuar aparecendo nessa métrica. "enviando" também entra
  // porque ainda não há confirmação de envio/sucesso.
  agendado: ["agendado", "pendente", "pausado", "enviando"],
  enviado: ["enviado", "entregue", "lido"],
  entregue: ["entregue", "lido"],
  lido: ["lido"],
  erro: ["erro"],
  bloqueado: ["bloqueado"],
  respondido: ["enviado", "entregue", "lido"],
  // Subconjunto especial filtrado também por colunas de confirmação:
  // - enviando + message id: provedor aceitou, confirmação local pendente;
  // - enviado + entrega_pendente_131026: aguardando delivered/read antes de
  //   decidir se o 131026 vira erro definitivo.
  aguardando_confirmacao: ["enviando", "enviado"],
};

export const REPLIED_QUEUE_DETAIL_KEY = "respondido";
export const PENDING_CONFIRMATION_QUEUE_DETAIL_KEY = "aguardando_confirmacao";

// Sintaxe raw do PostgREST usada por supabase-js .or(). Mantida centralizada
// para o card e o drilldown terem exatamente a mesma definição.
export const PENDING_CONFIRMATION_OR_FILTER =
  "and(status.eq.enviando,.not.waha_message_id.is.null),and(status.eq.enviado,entrega_pendente_131026.eq.true)";
