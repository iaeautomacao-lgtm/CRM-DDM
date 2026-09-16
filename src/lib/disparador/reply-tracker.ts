import { supabaseAdmin } from "@/lib/disparador/admin-client";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Quando um contato responde (webhook inbound Meta ou WAHA), tenta
// correlacionar a resposta com a campanha do Disparador mais recente que
// enviou para esse contato nos últimos 7 dias e incrementa
// campaign_metrics.total_respostas dessa campanha.
//
// `accountId` não é usado na query abaixo: disp_message_queue.contact_id
// já resolve para uma linha de `contacts` que só existe dentro da conta do
// chamador (o contact_id só chega até aqui depois de já ter sido
// resolvido/criado com account_id correto pelos webhooks), então não há
// necessidade de um filtro extra de tenancy aqui. Mantido no parâmetro
// para deixar o call site explícito sobre o contexto e para uma futura
// checagem defensiva caso disp_message_queue ganhe sua própria coluna
// account_id.
//
// Filtra por status IN ('enviado', 'entregue', 'lido') — não só 'enviado'
// como uma correlação ingênua sugeriria — porque o item avança na
// "escada" de status (agendado -> enviando -> enviado -> entregue -> lido,
// ver QUEUE_STATUS_LADDER em whatsapp/webhook/route.ts) assim que a Meta
// manda um recibo de entrega/leitura, o que normalmente já aconteceu
// antes de o contato ter tempo de responder. Um filtro só em 'enviado'
// deixaria de correlacionar a maioria das respostas reais.
//
// Usa `sent_at` para a janela de 7 dias, não `updated_at`: nenhuma
// migration cria o trigger `set_updated_at` para disp_message_queue (só
// tabelas específicas o têm — ver 001_initial_schema.sql e outras), e o
// código que transiciona o item para 'enviando'/'enviado' nunca seta
// `updated_at` manualmente, então essa coluna fica parada no valor de
// inserção da linha em vez de refletir quando a mensagem foi de fato
// enviada. `sent_at` é setado explicitamente no envio bem-sucedido
// (processQueue.ts) e nunca é tocado depois, mesmo quando o status avança
// para entregue/lido — é a coluna correta para "quando enviamos".
//
// Silencioso em qualquer falha — nunca deve derrubar o processamento do
// webhook que chama esta função.
export async function trackCampaignReply(
  contactId: string,
  accountId: string
): Promise<void> {
  void accountId;

  try {
    const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

    const { data: row, error } = await supabaseAdmin()
      .from("disp_message_queue")
      .select("campaign_id")
      .eq("contact_id", contactId)
      .in("status", ["enviado", "entregue", "lido"])
      .gte("sent_at", sevenDaysAgo)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[trackCampaignReply] falha ao buscar disp_message_queue:", error.message);
      return;
    }
    if (!row) return;

    const { error: rpcError } = await supabaseAdmin().rpc("increment_campaign_metric", {
      p_campaign_id: row.campaign_id,
      p_field: "total_respostas",
    });

    if (rpcError) {
      console.error("[trackCampaignReply] falha ao incrementar total_respostas:", rpcError.message);
    }
  } catch (err) {
    console.error("[trackCampaignReply] erro inesperado:", err);
  }
}
