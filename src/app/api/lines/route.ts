import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// GET /api/lines — todas as "linhas" da conta num formato só: números de
// WhatsApp (whatsapp_config, Meta ou WAHA) e contas de Instagram/Messenger
// (channels). Alimenta os filtros do inbox e o seletor de linhas das
// automações. Sem credenciais.

export interface LineOption {
  id: string
  channel_type: 'whatsapp' | 'instagram' | 'messenger' | 'sms'
  /** Só WhatsApp: meta | waha. */
  provider: 'meta' | 'waha' | null
  name: string
  team_id: string | null
  client_id: string | null
  habilitado: boolean
  /** Conversas WAHA antigas são ligadas por waha_session, não por config_id. */
  waha_session: string | null
}

export async function GET() {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount()
    const db = supabaseAdmin()
    // Agente/supervisor vê as linhas da(s) equipe(s) dele + as sem equipe —
    // mesma regra da RLS de whatsapp_config (migrations 103/135).
    let agentTeams: string[] | null = null
    if (role === 'agent' || role === 'supervisor') {
      const { data } = await db.from('team_members').select('team_id').eq('user_id', userId)
      agentTeams = (data ?? []).map((r: { team_id: string }) => r.team_id)
    }
    const [whatsapp, channels] = await Promise.all([
      supabase
        .from('whatsapp_config')
        .select('id, provider, display_phone_number, waha_session, team_id, client_id, habilitado')
        .eq('account_id', accountId),
      db
        .from('channels')
        .select('id, type, name, username, team_id, client_id, habilitado')
        .eq('account_id', accountId),
    ])
    if (whatsapp.error) throw whatsapp.error
    if (channels.error) throw channels.error
    const visibleChannels = (channels.data ?? []).filter(
      (c) => agentTeams === null || !c.team_id || agentTeams.includes(c.team_id)
    )

    const lines: LineOption[] = [
      ...(whatsapp.data ?? []).map((w) => ({
        id: w.id,
        channel_type: 'whatsapp' as const,
        provider: (w.provider ?? 'meta') as 'meta' | 'waha',
        name: w.display_phone_number || w.waha_session || 'WhatsApp',
        team_id: w.team_id ?? null,
        client_id: w.client_id ?? null,
        habilitado: w.habilitado ?? true,
        waha_session: w.waha_session ?? null,
      })),
      ...visibleChannels.map((c) => ({
        id: c.id,
        channel_type: c.type as LineOption['channel_type'],
        provider: null,
        name: c.username ? `${c.name} (@${c.username})` : c.name,
        team_id: c.team_id ?? null,
        client_id: c.client_id ?? null,
        habilitado: c.habilitado,
        waha_session: null,
      })),
    ]
    return NextResponse.json({ lines })
  } catch (err) {
    return toErrorResponse(err)
  }
}
