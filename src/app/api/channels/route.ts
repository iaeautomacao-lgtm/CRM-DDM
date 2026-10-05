import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { PUBLIC_CHANNEL_COLUMNS } from '@/lib/channels/store'

// GET /api/channels — canais Instagram/Messenger da conta, sem o token.
// (A tabela não tem acesso direto do navegador; ver migration 128.)

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const { data, error } = await supabaseAdmin()
      .from('channels')
      .select(PUBLIC_CHANNEL_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return NextResponse.json({ channels: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
