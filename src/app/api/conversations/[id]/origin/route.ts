import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildConversationOrigin } from '@/lib/conversations/origin'

// GET /api/conversations/[id]/origin — de onde veio a conversa (PRD-02):
// receptivo × ativo, campanha + template + o que foi enviado, linha/canal
// e cliente. A conversa é lida com a sessão do usuário (RLS: agente só vê
// as dele e a fila da equipe); o resto, com o service role, sempre
// filtrado pela conta.

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  webchat: 'Webchat',
  instagram: 'Instagram',
  messenger: 'Messenger',
  sms: 'SMS',
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data: convRows, error } = await supabase
      .from('conversations')
      .select('id, account_id, channel_type, config_id, channel_id, client_id, waha_session, origin_campaign_id, origin_queue_item_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .limit(1)
    if (error) throw error
    const conv = convRows?.[0]
    if (!conv) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })

    const db = supabaseAdmin()
    const { data: firstRows } = await db
      .from('messages')
      .select('sender_type, sender_id, content_type, content_text, template_name, campaign_id, queue_item_id, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(1)
    const first = firstRows?.[0] ?? null

    const campaignId: string | null = conv.origin_campaign_id ?? first?.campaign_id ?? null
    const queueItemId: string | null = conv.origin_queue_item_id ?? first?.queue_item_id ?? null

    const [campaignRes, queueRes, agentRes, flowRes, lineRes, clientRes] = await Promise.all([
      campaignId
        ? db.from('campaigns').select('id, nome').eq('id', campaignId).eq('account_id', accountId).limit(1)
        : Promise.resolve({ data: null }),
      queueItemId
        ? db
            .from('disp_message_queue')
            .select('template_name, mensagem_final, sent_at, campaign_id')
            .eq('id', queueItemId)
            .limit(1)
        : Promise.resolve({ data: null }),
      first?.sender_type === 'agent' && first.sender_id
        ? db.from('profiles').select('full_name').eq('user_id', first.sender_id).eq('account_id', accountId).limit(1)
        : Promise.resolve({ data: null }),
      first?.sender_type === 'bot'
        ? db
            .from('flow_runs')
            .select('flow:flows!flow_id(name)')
            .eq('conversation_id', id)
            .order('started_at', { ascending: true })
            .limit(1)
        : Promise.resolve({ data: null }),
      conv.channel_id
        ? db.from('channels').select('name, username').eq('id', conv.channel_id).eq('account_id', accountId).limit(1)
        : conv.config_id
          ? db
              .from('whatsapp_config')
              .select('display_phone_number, waha_session')
              .eq('id', conv.config_id)
              .eq('account_id', accountId)
              .limit(1)
          : Promise.resolve({ data: null }),
      conv.client_id
        ? db.from('clients').select('id, name, color').eq('id', conv.client_id).eq('account_id', accountId).limit(1)
        : Promise.resolve({ data: null }),
    ])

    const campaignRow = (campaignRes.data as Array<{ id: string; nome: string }> | null)?.[0]
    const queueRow = (queueRes.data as Array<{
      template_name: string | null
      mensagem_final: string | null
      sent_at: string | null
      campaign_id: string | null
    }> | null)?.[0]
    // Item da fila só vale se for da mesma campanha (não confiar em id solto).
    const sent = queueRow && (!campaignId || queueRow.campaign_id === campaignId) ? queueRow : null
    const flowRow = (flowRes.data as Array<{ flow: { name: string } | { name: string }[] | null }> | null)?.[0]
    const flowName = Array.isArray(flowRow?.flow) ? flowRow?.flow[0]?.name : flowRow?.flow?.name
    const line = (lineRes.data as Array<Record<string, string | null>> | null)?.[0]

    const origin = buildConversationOrigin({
      originCampaignId: campaignId,
      firstMessage: first,
      campaign: campaignRow ? { id: campaignRow.id, name: campaignRow.nome } : null,
      sent: sent ? { template_name: sent.template_name, text: sent.mensagem_final, sent_at: sent.sent_at } : null,
      agentName: (agentRes.data as Array<{ full_name: string | null }> | null)?.[0]?.full_name ?? null,
      flowName: flowName ?? null,
    })

    return NextResponse.json({
      origin,
      channel: CHANNEL_LABEL[conv.channel_type ?? 'whatsapp'] ?? conv.channel_type,
      line: line
        ? line.username
          ? `${line.name} (@${line.username})`
          : line.name ?? line.display_phone_number ?? line.waha_session ?? null
        : conv.waha_session ?? null,
      client: (clientRes.data as Array<{ id: string; name: string; color: string }> | null)?.[0] ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
