import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getWahaProfilePicture } from '@/lib/whatsapp/waha-api'

// Teto por chamada (200 ms por contato): quem tem mais contatos chama de novo.
const MAX_CONTACTS_PER_RUN = 500

export async function POST(request: Request) {
  // Laço de 200 ms por contato com a chave WAHA da conta: só admin.
  const auth = await guardPermission('channels.manage')
  if (!auth.ok) return auth.response
  const account_id = auth.ctx.accountId

  const db = supabaseAdmin()

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('waha_url, waha_session, waha_api_key')
    .eq('account_id', account_id)
    .maybeSingle()

  if (configError || !config) {
    return NextResponse.json({ error: 'Configuração não encontrada' }, { status: 404 })
  }

  const { data: contacts, error: contactsError } = await db
    .from('contacts')
    .select('id, phone')
    .eq('account_id', account_id)
    .or('avatar_url.is.null,avatar_url.eq.')
    .limit(MAX_CONTACTS_PER_RUN)

  if (contactsError || !contacts) {
    return NextResponse.json({ error: 'Falha ao buscar os contatos' }, { status: 500 })
  }

  const wahaConfig = {
    waha_url: config.waha_url,
    waha_session: config.waha_session,
    waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
  }

  let updated = 0
  let failed = 0

  for (const contact of contacts) {
    try {
      const avatarUrl = await getWahaProfilePicture(wahaConfig, contact.phone)
      if (avatarUrl) {
        await db
          .from('contacts')
          .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
          .eq('id', contact.id)
        updated++
      }
    } catch {
      failed++
    }
    await new Promise(r => setTimeout(r, 200))
  }

  return NextResponse.json({
    total: contacts.length,
    updated,
    failed,
    skipped: contacts.length - updated - failed,
  })
}
