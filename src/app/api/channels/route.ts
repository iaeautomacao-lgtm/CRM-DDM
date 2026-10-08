import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { PUBLIC_CHANNEL_COLUMNS } from '@/lib/channels/store'
import { socialConnectMissingEnv } from '@/lib/channels/oauth'

// GET /api/channels — canais Instagram/Messenger da conta, sem o token.
// (A tabela não tem acesso direto do navegador; ver migration 128.)

export async function GET() {
  try {
    const { accountId } = await requirePermission('channels.view')
    const { data, error } = await supabaseAdmin()
      .from('channels')
      .select(PUBLIC_CHANNEL_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    if (error) throw error
    // O que falta no servidor para cada botão "Conectar" funcionar.
    return NextResponse.json({
      channels: data ?? [],
      setup: {
        instagram: { missing: socialConnectMissingEnv('instagram') },
        messenger: { missing: socialConnectMissingEnv('messenger') },
        webhook_verify_token: !!process.env.META_WEBHOOK_VERIFY_TOKEN,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
