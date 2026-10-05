import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadWebchatSettings, normalizeWebchatSettings } from '@/lib/webchat/settings'

// GET/PUT /api/webchat/settings — configuração do Webchat da conta
// (owner/admin, tela /canais). A tabela não tem acesso direto do navegador
// (migration 133). GET também diz se o servidor tem NEXT_PUBLIC_APP_URL,
// sem a qual os links do Webchat não podem ser gerados.

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const settings = await loadWebchatSettings(supabaseAdmin(), accountId)
    return NextResponse.json({
      settings,
      ready: !!process.env.NEXT_PUBLIC_APP_URL?.startsWith('https://'),
      base_url: process.env.NEXT_PUBLIC_APP_URL ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
    const settings = normalizeWebchatSettings(body)
    const db = supabaseAdmin()

    // Fluxo padrão precisa ser da conta.
    if (settings.default_flow_id) {
      const { data } = await db
        .from('flows')
        .select('id')
        .eq('id', settings.default_flow_id)
        .eq('account_id', accountId)
        .limit(1)
      if (!data?.[0]) return NextResponse.json({ error: 'Fluxo inválido' }, { status: 400 })
    }

    const { error } = await db
      .from('webchat_settings')
      .upsert(
        { account_id: accountId, ...settings, updated_at: new Date().toISOString(), updated_by: userId },
        { onConflict: 'account_id' },
      )
    if (error) throw error
    return NextResponse.json({ settings })
  } catch (err) {
    return toErrorResponse(err)
  }
}
