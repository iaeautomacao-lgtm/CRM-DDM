import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { PUBLIC_CHANNEL_COLUMNS } from '@/lib/channels/store'

// /api/channels/[id] — PATCH (nome, equipe, fluxo receptivo, cliente,
// ativo) e DELETE. O segmento se chama [type] porque divide a pasta com
// /api/channels/[type]/connect|callback; aqui ele é o id do canal.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EDITABLE = ['name', 'team_id', 'flow_id', 'client_id', 'habilitado'] as const

export async function PATCH(request: Request, { params }: { params: Promise<{ type: string }> }) {
  try {
    const { accountId } = await requirePermission('channels.manage')
    const { type: id } = await params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Canal inválido' }, { status: 404 })
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const key of EDITABLE) {
      if (key in body) updates[key] = body[key] === '' ? null : body[key]
    }
    if (typeof updates.name === 'string' && !updates.name.trim()) {
      return NextResponse.json({ error: 'Nome obrigatório' }, { status: 400 })
    }
    if ('habilitado' in updates && typeof updates.habilitado !== 'boolean') {
      return NextResponse.json({ error: 'habilitado inválido' }, { status: 400 })
    }
    // Equipe/fluxo/cliente precisam ser da mesma conta.
    const db = supabaseAdmin()
    for (const [key, table] of [['team_id', 'teams'], ['flow_id', 'flows'], ['client_id', 'clients']] as const) {
      const value = updates[key]
      if (value == null) continue
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        return NextResponse.json({ error: `${key} inválido` }, { status: 400 })
      }
      const { data } = await db.from(table).select('id').eq('id', value).eq('account_id', accountId).limit(1)
      if (!data?.length) return NextResponse.json({ error: `${key} não encontrado` }, { status: 400 })
    }

    const { data, error } = await db
      .from('channels')
      .update(updates)
      .eq('id', id)
      .eq('account_id', accountId)
      .select(PUBLIC_CHANNEL_COLUMNS)
      .limit(1)
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: 'Canal não encontrado' }, { status: 404 })
    return NextResponse.json({ channel: data[0] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ type: string }> }) {
  try {
    const { accountId } = await requirePermission('channels.manage')
    const { type: id } = await params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Canal inválido' }, { status: 404 })
    // Conversas ficam (channel_id vira NULL pela FK); só não chegam mais
    // mensagens novas por esta linha.
    const { error } = await supabaseAdmin()
      .from('channels')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
