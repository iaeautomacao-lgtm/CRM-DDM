import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// POST /api/quick-replies/[id]/use   (TASK1 item 4 — contagem de usos em 30 dias)
// O Inbox chama quando o operador USA a resposta rápida (insere no campo). Permissão inbox.reply; a resposta precisa ser VISÍVEL
// para ele (RLS de quick_replies: pessoal só do dono, equipe só dos membros, conta de todos) — senão 404, sem revelar que existe.
// Registro por contador diário (wacrm.bump_quick_reply_use, migration 301, só service role). É telemetria de uso, não auditoria de
// escrita de dado: não gera evento de auditoria. Leitura dos totais: RPC wacrm.quick_reply_usage_30d() → [{quick_reply_id, uses}].
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requirePermission('inbox.reply')
    const { id } = await params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Resposta rápida inválida' }, { status: 400 })

    const { data, error } = await supabase
      .from('quick_replies')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .limit(1)
    if (error) throw error
    if (!data?.[0]) return NextResponse.json({ error: 'Resposta rápida não encontrada' }, { status: 404 })

    const { error: bumpError } = await supabaseAdmin().rpc('bump_quick_reply_use', {
      p_reply: id,
      p_account: accountId,
      p_user: userId,
    })
    if (bumpError) throw bumpError
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
