// Conversa aberta (ou nova) de um contato num canal, para as rotas de envio da API pública (/whatsapp/send e /whatsapp/send-template).
// Extraída de whatsapp/send/route.ts SEM mudar comportamento.

export async function findOrCreateConversation(
  supabase: any,
  accountId: string,
  userId: string,
  contactId: string,
  wahaSession?: string,
  configId?: string
) {
  let query = supabase
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    // A API v1 envia por WhatsApp; nunca reaproveita a conversa de Webchat.
    .eq('channel_type', 'whatsapp')
    .in('status', ['open', 'pending']);

  if (wahaSession) {
    query = query.eq('waha_session', wahaSession);
  } else {
    query = query.is('waha_session', null);
  }
  if (configId) {
    query = query.eq('config_id', configId);
  }

  const { data: candidates, error: findError } = await query.order('created_at', { ascending: false });

  if (findError) {
    // Não derruba o fluxo — segue pro insert abaixo, mesmo comportamento
    // de antes (que também nunca falhava aqui), só que agora com o erro
    // logado em vez de silenciosamente ignorado.
    console.error('Error finding existing conversation in API send:', findError.message);
  }

  // Fallback: candidata open/pending mais recentemente criada (comportamento
  // anterior). Só reavaliada abaixo se houver mais de uma candidata — nesse
  // caso comum (0 ou 1) a query extra de mensagens nunca roda.
  let existing = candidates?.[0] ?? null;

  if (candidates && candidates.length > 1) {
    // Mais de uma conversa aberta/pendente para este contato+canal —
    // prioriza a que tem mensagem do cliente dentro da janela de 24h da
    // Meta (sender_type='customer', valor confirmado ao vivo contra
    // wacrm.messages — 'contact' nunca aparece lá; ver mesmo bug corrigido
    // em startCampaign.ts). received_at (não created_at) é o timestamp de
    // quando o webhook processou a mensagem, mesmo campo já usado pelo
    // windowMap de startCampaign.ts.
    const candidateIds = candidates.map((c: { id: string }) => c.id);
    const { data: lastCustomerMsgs } = await supabase
      .from('messages')
      .select('conversation_id, received_at')
      .in('conversation_id', candidateIds)
      .eq('sender_type', 'customer')
      .order('received_at', { ascending: false });

    const lastByConversation = new Map<string, number>();
    for (const row of lastCustomerMsgs ?? []) {
      if (!lastByConversation.has(row.conversation_id)) {
        lastByConversation.set(row.conversation_id, new Date(row.received_at).getTime());
      }
    }

    const now = Date.now();
    const active = candidates.find(
      (c: { id: string }) => lastByConversation.has(c.id) && now - lastByConversation.get(c.id)! < 24 * 60 * 60 * 1000
    );
    if (active) existing = active;
  }

  if (existing) return existing;

  const insertObj: any = {
    account_id: accountId,
    user_id: userId,
    contact_id: contactId,
  };
  if (wahaSession) {
    insertObj.waha_session = wahaSession;
  }
  if (configId) {
    insertObj.config_id = configId;
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert(insertObj)
    .select('*, contact:contacts(*)')
    .single();

  if (error) {
    console.error('Error creating conversation in API send:', error.message);
    return null;
  }

  return created;
}
