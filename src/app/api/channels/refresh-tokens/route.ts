import { trackCron } from "@/lib/ops/cron-heartbeat"
import { NextResponse } from 'next/server'
import { registerAuditActor } from '@/lib/audit/context'
import { matchesOperationalSecret } from '@/lib/auth/operational-secret'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { refreshInstagramToken } from '@/lib/channels/oauth'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

// POST /api/channels/refresh-tokens — cron diário (crontab do cPanel,
// header x-cron-secret = AUTOMATION_CRON_SECRET, igual ao de automações).
//
// O token longo do Instagram Login vale 60 dias e só renova enquanto
// válido (e com mais de 24h de idade). Renovamos os que vencem em até 10
// dias. Token de Página do Messenger obtido de token longo não expira —
// fica de fora. Falha marca o canal como 'error' para aparecer em /canais.
// Stateless: cada execução lê o que vence e trata em lotes.

const REFRESH_WINDOW_DAYS = 10
const BATCH = 50

async function handler(request: Request) {
  // Auditoria: escritas desta requisição saem como "system" (cron_tokens).
  await registerAuditActor({ actorType: 'system', source: 'cron_tokens' })
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  if (!matchesOperationalSecret(expected, request.headers.get('x-cron-secret'))) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const limit = new Date(Date.now() + REFRESH_WINDOW_DAYS * 86_400_000).toISOString()
  const { data: due, error } = await db
    .from('channels')
    .select('id, access_token')
    .eq('type', 'instagram')
    .neq('status', 'disconnected')
    .gt('token_expires_at', new Date().toISOString())
    .lte('token_expires_at', limit)
    .order('token_expires_at', { ascending: true })
    .limit(BATCH)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let refreshed = 0
  let failed = 0
  for (const row of due ?? []) {
    try {
      const next = await refreshInstagramToken(decrypt(row.access_token))
      await db
        .from('channels')
        .update({
          access_token: encrypt(next.accessToken),
          token_expires_at: next.expiresAt,
          status: 'connected',
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
      refreshed++
    } catch (err) {
      failed++
      await db
        .from('channels')
        .update({
          status: 'error',
          last_error: `Falha ao renovar token: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
    }
  }
  return NextResponse.json({ checked: due?.length ?? 0, refreshed, failed })
}

export const POST = (request: Request) => trackCron("channels_refresh_tokens", () => handler(request))