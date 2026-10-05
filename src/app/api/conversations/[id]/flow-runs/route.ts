import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

// GET /api/conversations/[id]/flow-runs
//
// Execuções de fluxo ligadas a uma conversa, para o card "Fluxo" do painel
// do contato no inbox. Restrito a owner/admin (decisão de produto: o agente
// não vê nem abre o fluxo).
//
// Busca primeiro por conversation_id. Runs antigos ou iniciados sem
// conversa ficam só com contact_id; nesse caso cai para os runs do contato,
// o mesmo fallback que endActiveRunForConversation usa no engine.

const RUN_LIMIT = 5

const RUN_COLUMNS =
  'id, flow_id, status, current_node_key, started_at, last_advanced_at, ended_at, end_reason, flow:flows!flow_id(id, name)'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id: conversationId } = await params

    const { data: conversations, error: convError } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .limit(1)
    if (convError) throw convError
    const conversation = conversations?.[0]
    if (!conversation) {
      return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    }

    const byConversation = await supabase
      .from('flow_runs')
      .select(RUN_COLUMNS)
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .order('started_at', { ascending: false })
      .limit(RUN_LIMIT)
    if (byConversation.error) throw byConversation.error

    let runs = byConversation.data ?? []
    let matchedBy: 'conversation' | 'contact' = 'conversation'
    if (runs.length === 0 && conversation.contact_id) {
      const byContact = await supabase
        .from('flow_runs')
        .select(RUN_COLUMNS)
        .eq('account_id', accountId)
        .eq('contact_id', conversation.contact_id)
        .order('started_at', { ascending: false })
        .limit(RUN_LIMIT)
      if (byContact.error) throw byContact.error
      runs = byContact.data ?? []
      matchedBy = 'contact'
    }

    // node_type do nó atual, para o card mostrar "Coletar resposta",
    // "Transferir para agente" etc. (rótulos de NODE_META no cliente).
    const nodeLookups = runs
      .filter((r) => r.current_node_key)
      .map((r) => ({ flow_id: r.flow_id, node_key: r.current_node_key as string }))
    const nodeTypes = new Map<string, string>()
    if (nodeLookups.length > 0) {
      const { data: nodes, error: nodesError } = await supabase
        .from('flow_nodes')
        .select('flow_id, node_key, node_type')
        .in('flow_id', [...new Set(nodeLookups.map((n) => n.flow_id))])
        .in('node_key', [...new Set(nodeLookups.map((n) => n.node_key))])
      if (nodesError) throw nodesError
      for (const n of nodes ?? []) nodeTypes.set(`${n.flow_id}:${n.node_key}`, n.node_type)
    }

    return NextResponse.json({
      matched_by: matchedBy,
      runs: runs.map((r) => {
        // O embed pode vir como objeto ou array conforme o cache do PostgREST.
        const flow = Array.isArray(r.flow) ? r.flow[0] : r.flow
        return {
          id: r.id,
          flow_id: r.flow_id,
          flow_name: flow?.name ?? null,
          status: r.status,
          current_node_key: r.current_node_key,
          current_node_type: r.current_node_key
            ? (nodeTypes.get(`${r.flow_id}:${r.current_node_key}`) ?? null)
            : null,
          started_at: r.started_at,
          last_advanced_at: r.last_advanced_at,
          ended_at: r.ended_at,
          end_reason: r.end_reason,
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
