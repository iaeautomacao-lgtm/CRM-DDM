import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getWahaProfilePicture } from '@/lib/whatsapp/waha-api'

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const { account_id } = await request.json()

  if (!account_id) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('waha_url, waha_session, waha_api_key')
    .eq('account_id', account_id)
    .maybeSingle()

  if (configError || !config) {
    return NextResponse.json({ error: 'Config not found' }, { status: 404 })
  }

  const { data: contacts, error: contactsError } = await db
    .from('contacts')
    .select('id, phone')
    .eq('account_id', account_id)
    .or('avatar_url.is.null,avatar_url.eq.')

  if (contactsError || !contacts) {
    return NextResponse.json({ error: 'Failed to fetch contacts' }, { status: 500 })
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
