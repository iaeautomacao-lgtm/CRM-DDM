import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'

/**
 * GET /api/whatsapp/channel-test/templates?configId=...
 *
 * Lists this account's APPROVED templates so the channel test dialog
 * can offer one to send through a Meta channel — Meta has no
 * free-text send path, only approved templates.
 */
export async function GET(request: Request) {
  try {
    // Templates/canais mexem no WABA da conta (Meta) ou no número conectado: só admin
    // (mesmo papel das páginas /templates e /canais).
    const auth = await guardPermission('channels.manage')
    if (!auth.ok) return auth.response
    const { supabase, accountId } = auth.ctx

    const { searchParams } = new URL(request.url)
    const configId = searchParams.get('configId')

    if (!configId) {
      return NextResponse.json({ error: 'configId é obrigatório' }, { status: 400 })
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('id, waba_id')
      .eq('id', configId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError || !config) {
      return NextResponse.json({ error: 'Canal não encontrado' }, { status: 404 })
    }

    let templatesQuery = supabase
      .from('message_templates')
      .select('id, name, language, body_text')
      .eq('account_id', accountId)
      .eq('status', 'APPROVED')
      .order('name', { ascending: true })

    // Filtra por waba_id quando disponível — garante que só
    // templates aprovados para este canal específico aparecem.
    // Se waba_id for null (canal antigo sem waba_id populado),
    // retorna todos para não quebrar o teste.
    const wabaId = (config as { id: string; waba_id: string | null }).waba_id
    if (wabaId) {
      templatesQuery = templatesQuery.eq('waba_id', wabaId)
    }

    const { data: templates, error: templatesError } = await templatesQuery

    if (templatesError) {
      console.error('[channel-test/templates] failed to load templates:', templatesError)
      return NextResponse.json({ error: 'Falha ao carregar os templates' }, { status: 500 })
    }

    return NextResponse.json({ templates: templates ?? [] })
  } catch (error) {
    console.error('Error in WhatsApp channel-test/templates GET:', error)
    return NextResponse.json({ error: 'Falha ao carregar os templates' }, { status: 500 })
  }
}
