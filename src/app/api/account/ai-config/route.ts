import { NextResponse } from 'next/server'
import { auditFetch } from '@/lib/audit/context'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { encrypt, tryDecrypt } from '@/lib/whatsapp/encryption'
import {
  aiProviderLabel,
  isAiProvider,
  isModelCompatibleWithProvider,
} from '@/lib/ai/models'

// Server-side owner of wacrm.ai_config — the browser client never reads
// or writes api_key/elevenlabs_api_key directly (that was the finding:
// both columns round-tripped in plaintext through the anon-key client).
// Lazy-initialized, same shape as every other admin-client copy in this
// codebase (see src/lib/disparador/admin-client.ts).
let _adminClient: SupabaseClient | null = null
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      {
        db: {
          schema: 'wacrm',
        },
        // Autor/IP para as triggers de auditoria (migration 131).
        global: { fetch: auditFetch },
      }
    ) as any
  }
  return _adminClient!
}

// Must match the constant of the same name in
// src/components/settings/ai-agent-settings.tsx — the frontend can't
// import this file directly (it pulls in server-only Node deps via
// supabaseAdmin/encrypt), so the literal is duplicated intentionally.
// It's what the client sends back unchanged to mean "user didn't touch
// this field, keep whatever's already stored."
const MASKED_SENTINEL = '••••••••'

// Partial-reveal mask for the GET response — never the real secret,
// just enough (first 3 / last 4 chars) for the account owner to
// recognize which key is currently configured without re-exposing it.
function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 7) return '•'.repeat(8)
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`
}

async function resolveAccountId(): Promise<
  { accountId: string } | { error: NextResponse }
> {
  const supabase = await createServerClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()

  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return {
      error: NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      ),
    }
  }

  return { accountId }
}

const DEFAULT_CONFIG = {
  enabled: false,
  api_provider: 'gemini',
  api_key: '',
  system_prompt: '',
  google_search_enabled: false,
  multimodal_enabled: false,
  elevenlabs_enabled: false,
  elevenlabs_api_key: '',
  elevenlabs_voice_id: '',
  elevenlabs_model_id: 'eleven_multilingual_v2',
}

export async function GET() {
  try {
    const resolved = await resolveAccountId()
    if ('error' in resolved) return resolved.error
    const { accountId } = resolved

    const { data: aiConfig, error } = await supabaseAdmin()
      .from('ai_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!aiConfig) {
      return NextResponse.json(DEFAULT_CONFIG)
    }

    // Old rows were written in plaintext before this endpoint existed —
    // tryDecrypt() falls back to the raw value when it isn't in the
    // encrypt() shape, so both old and new rows mask correctly.
    const rawApiKey = aiConfig.api_key ? tryDecrypt(aiConfig.api_key) : ''
    const rawElevenlabsKey = aiConfig.elevenlabs_api_key
      ? tryDecrypt(aiConfig.elevenlabs_api_key)
      : ''

    return NextResponse.json({
      enabled: !!aiConfig.enabled,
      api_provider: aiConfig.api_provider || 'gemini',
      api_key: maskSecret(rawApiKey),
      system_prompt: aiConfig.system_prompt || '',
      google_search_enabled: !!aiConfig.google_search_enabled,
      multimodal_enabled: !!aiConfig.multimodal_enabled,
      elevenlabs_enabled: !!aiConfig.elevenlabs_enabled,
      elevenlabs_api_key: maskSecret(rawElevenlabsKey),
      elevenlabs_voice_id: aiConfig.elevenlabs_voice_id || '',
      elevenlabs_model_id: aiConfig.elevenlabs_model_id || 'eleven_multilingual_v2',
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to load AI config' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const resolved = await resolveAccountId()
    if ('error' in resolved) return resolved.error
    const { accountId } = resolved

    const body = await request.json()

    if (!isAiProvider(body.api_provider)) {
      return NextResponse.json(
        { error: 'Provider de IA inválido.' },
        { status: 400 },
      )
    }

    // Trocar o provider da conta não pode invalidar silenciosamente um
    // fluxo ativo que fixou um modelo no nó. Drafts podem permanecer com
    // config incompleta/incompatível até a próxima ativação.
    const { data: activeFlows, error: activeFlowsError } = await supabaseAdmin()
      .from('flows')
      .select('id, name')
      .eq('account_id', accountId)
      .eq('status', 'active')

    if (activeFlowsError) {
      return NextResponse.json({ error: activeFlowsError.message }, { status: 500 })
    }

    const activeFlowIds = (activeFlows ?? []).map((flow) => flow.id)
    if (activeFlowIds.length > 0) {
      const { data: aiNodes, error: aiNodesError } = await supabaseAdmin()
        .from('flow_nodes')
        .select('flow_id, node_key, config')
        .in('flow_id', activeFlowIds)
        .eq('node_type', 'ai_agent')

      if (aiNodesError) {
        return NextResponse.json({ error: aiNodesError.message }, { status: 500 })
      }

      const incompatible = (aiNodes ?? []).filter((node) => {
        const model =
          node.config &&
          typeof node.config === 'object' &&
          typeof (node.config as { model?: unknown }).model === 'string'
            ? (node.config as { model: string }).model.trim()
            : ''
        return !!model && !isModelCompatibleWithProvider(model, body.api_provider)
      })

      if (incompatible.length > 0) {
        return NextResponse.json(
          {
            error:
              `Não é possível trocar o provider para ${aiProviderLabel(body.api_provider)} enquanto houver nós de IA ativos com modelos incompatíveis.`,
            code: 'active_flow_model_provider_mismatch',
            nodes: incompatible.map((node) => ({
              flow_id: node.flow_id,
              node_key: node.node_key,
              model: (node.config as { model: string }).model,
            })),
          },
          { status: 409 },
        )
      }
    }

    if (body.enabled && body.api_provider !== 'hermes') {
      const sendingNewKey = typeof body.api_key === 'string' && body.api_key !== MASKED_SENTINEL && !!body.api_key.trim()
      let keyProvided = sendingNewKey

      // Sentinel alone only counts as "keep the existing key" if a key
      // actually exists to keep — a client sending the sentinel with no
      // real row behind it (shouldn't happen via the normal UI, which
      // only ever sets the sentinel after GET confirmed a key exists,
      // but don't trust that blindly) must not slip through unvalidated.
      if (!keyProvided && body.api_key === MASKED_SENTINEL) {
        const { data: existing } = await supabaseAdmin()
          .from('ai_config')
          .select('api_key')
          .eq('account_id', accountId)
          .maybeSingle()
        keyProvided = !!existing?.api_key?.trim()
      }

      if (!keyProvided) {
        return NextResponse.json(
          { error: 'A chave de API é obrigatória para ativar o Agente de IA' },
          { status: 400 }
        )
      }
    }

    const payload: Record<string, unknown> = {
      account_id: accountId,
      enabled: !!body.enabled,
      api_provider: body.api_provider,
      system_prompt: typeof body.system_prompt === 'string' ? body.system_prompt.trim() : '',
      google_search_enabled: !!body.google_search_enabled,
      multimodal_enabled: !!body.multimodal_enabled,
      elevenlabs_enabled: !!body.elevenlabs_enabled,
      elevenlabs_voice_id:
        typeof body.elevenlabs_voice_id === 'string' ? body.elevenlabs_voice_id.trim() || null : null,
      elevenlabs_model_id:
        (typeof body.elevenlabs_model_id === 'string' && body.elevenlabs_model_id.trim()) ||
        'eleven_multilingual_v2',
      updated_at: new Date().toISOString(),
    }

    // Only touch api_key/elevenlabs_api_key when the client actually sent
    // a new value — MASKED_SENTINEL means "unchanged", and PostgREST's
    // upsert only updates columns present in the payload, so omitting
    // the key here leaves whatever's already stored untouched.
    if (typeof body.api_key === 'string' && body.api_key !== MASKED_SENTINEL) {
      const trimmed = body.api_key.trim()
      payload.api_key = trimmed ? encrypt(trimmed) : null
    }
    if (typeof body.elevenlabs_api_key === 'string' && body.elevenlabs_api_key !== MASKED_SENTINEL) {
      const trimmed = body.elevenlabs_api_key.trim()
      payload.elevenlabs_api_key = trimmed ? encrypt(trimmed) : null
    }

    const { error } = await supabaseAdmin()
      .from('ai_config')
      .upsert(payload, { onConflict: 'account_id' })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to save AI config' },
      { status: 500 }
    )
  }
}
