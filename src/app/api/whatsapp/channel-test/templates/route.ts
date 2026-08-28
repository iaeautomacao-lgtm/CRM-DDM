import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/whatsapp/channel-test/templates?configId=...
 *
 * Lists this account's APPROVED templates so the channel test dialog
 * can offer one to send through a Meta channel — Meta has no
 * free-text send path, only approved templates.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { searchParams } = new URL(request.url)
    const configId = searchParams.get('configId')

    if (!configId) {
      return NextResponse.json({ error: 'configId is required' }, { status: 400 })
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('id', configId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError || !config) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    const { data: templates, error: templatesError } = await supabase
      .from('message_templates')
      .select('id, name, language, body_text')
      .eq('account_id', accountId)
      .eq('status', 'APPROVED')
      .order('name', { ascending: true })

    if (templatesError) {
      console.error('[channel-test/templates] failed to load templates:', templatesError)
      return NextResponse.json({ error: 'Failed to load templates' }, { status: 500 })
    }

    return NextResponse.json({ templates: templates ?? [] })
  } catch (error) {
    console.error('Error in WhatsApp channel-test/templates GET:', error)
    return NextResponse.json({ error: 'Failed to load templates' }, { status: 500 })
  }
}
