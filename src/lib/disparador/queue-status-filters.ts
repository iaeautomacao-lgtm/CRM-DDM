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
};

export const REPLIED_QUEUE_DETAIL_KEY = "respondido";
