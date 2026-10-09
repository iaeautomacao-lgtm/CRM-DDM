import { NextResponse } from 'next/server'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import { auditFetch } from '@/lib/audit/context'
import { createClient } from '@/lib/supabase/server'
import { isAccountRole } from '@/lib/auth/roles'
import { can } from '@/lib/auth/permissions'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import {
  encrypt,
  decryptStoredSecret,
  ensureEncryptedSecret,
} from '@/lib/whatsapp/encryption'
import { resolveSecretForWrite } from '@/lib/whatsapp/secret-write'
import {
  getWahaSessionStatus,
  getWahaSessionInfo,
  startWahaSession,
  assertWahaUrlIsSafe,
  WahaUrlBlockedError,
} from '@/lib/whatsapp/waha-api'
import { wahaWebhookFor } from '@/lib/whatsapp/waha-webhook-auth'

// Migration 113 — a WAHA session with no message activity for longer
// than this is flagged 'warning' rather than plain 'connected', even
// though the session itself is technically WORKING.
const WARNING_STALE_ACTIVITY_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        db: {
          schema: 'wacrm',
        },
        // Autor/IP para as triggers de auditoria (migration 131).
        global: { fetch: auditFetch },
      }
    ) as any
  }
  return _adminClient
}

/**
 * Papel mínimo para ALTERAR/APAGAR canais: admin (o mesmo do POST e da RLS
 * whatsapp_config_update/delete). Antes DELETE e PATCH dependiam só da RLS —
 * se a policy do banco divergir da migration (CLAUDE.md avisa que acontece),
 * qualquer papel apagava ou editava canal (PRD 20, G1). O GET segue aberto a
 * qualquer membro: o inbox o usa para saber se há canal conectado e a resposta
 * nunca traz segredo (só has_app_secret).
 */
async function requireChannelAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  message: string,
): Promise<NextResponse | null> {
  const { data: roleRow } = await supabase
    .from('profiles')
    .select('account_role')
    .eq('user_id', userId)
    .maybeSingle()
  const role = (roleRow as { account_role?: string } | null)?.account_role
  if (!role || !isAccountRole(role) || !can({ role }, 'channels.manage')) {
    return NextResponse.json({ error: message }, { status: 403 })
  }
  return null
}

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved configs are healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Seu perfil não está vinculado a uma conta.',
        },
        { status: 200 },
      )
    }

    // Segredos só pelo servidor (migration 200b): a visibilidade segue a RLS
    // do usuário e a resposta (abaixo) nunca devolve o valor dos segredos.
    const { data: configs, error: configError } = await fetchChannelConfigs(
      supabase,
      accountId,
      (q) => q.eq('account_id', accountId)
    )

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Falha ao buscar a configuração' },
        { status: 200 }
      )
    }

    if (!configs || configs.length === 0) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'Nenhuma configuração de WhatsApp salva ainda. Preencha o formulário e clique em Salvar configuração.',
        },
        { status: 200 }
      )
    }

    // Last message activity per config, for the WAHA 'warning' check
    // below — a session can be WORKING (connected) yet have gone quiet.
    // Only rows that ever had a message are considered; a brand-new
    // channel with no history yet is not flagged (nothing to compare
    // against).
    const configIds = configs.map((c: any) => c.id)
    const { data: activityRows } = await supabase
      .from('conversations')
      .select('config_id, last_message_at')
      .in('config_id', configIds)
      .not('config_id', 'is', null)
      .not('last_message_at', 'is', null)
      .order('last_message_at', { ascending: false })

    const lastActivityByConfig = new Map<string, string>()
    for (const row of activityRows ?? []) {
      if (!lastActivityByConfig.has(row.config_id)) {
        lastActivityByConfig.set(row.config_id, row.last_message_at)
      }
    }

    const configsWithStatus = await Promise.all(
      configs.map(async (config: any) => {
        if (config.provider === 'waha') {
          const wahaConfig = {
            waha_url: config.waha_url,
            waha_session: config.waha_session,
            waha_api_key: config.waha_api_key
              ? decryptStoredSecret(config.waha_api_key, 'whatsapp_config.waha_api_key')
              : null,
          }
          try {
            const wahaSession = await getWahaSessionInfo(wahaConfig)
            const status = wahaSession ? wahaSession.status : 'STOPPED'
            
            let displayPhone = config.waha_session
            let pushName = ''
            
            if (wahaSession?.me?.id) {
              const raw = wahaSession.me.id.replace('@c.us', '').replace('@lid', '')
              displayPhone = `+${raw}`
              pushName = wahaSession.me.pushName || ''
            }

            const connected = status === 'WORKING'

            // 'warning' — connected, but no message activity in the
            // last 24h (see WARNING_STALE_ACTIVITY_MS).
            let derivedStatus: 'connected' | 'disconnected' | 'warning' =
              connected ? 'connected' : 'disconnected'
            let warning_reason: string | undefined
            let warning_message: string | undefined
            if (connected) {
              const lastActivity = lastActivityByConfig.get(config.id)
              if (lastActivity && Date.now() - new Date(lastActivity).getTime() > WARNING_STALE_ACTIVITY_MS) {
                derivedStatus = 'warning'
                warning_reason = 'stale_activity'
                warning_message = 'Última atividade há mais de 24h'
              }
            }

            return {
              id: config.id,
              connected,
              status: derivedStatus,
              warning_reason,
              warning_message,
              provider: 'waha',
              session_status: status,
              waha_session: config.waha_session,
              waha_url: config.waha_url,
              flow_id: config.flow_id,
              receptivo: config.receptivo,
              habilitado: config.habilitado,
              team_id: config.team_id,
              phone_info: {
                id: config.waha_session,
                display_phone_number: displayPhone,
                verified_name: pushName ? `WAHA: ${pushName} (${config.waha_session})` : `WAHA: ${config.waha_session}`
              }
            }
          } catch (err: any) {
            // Log the real error server-side only — the client-facing
            // message must not echo the internal connection error (host
            // reachability, refused ports, etc. can be an SSRF oracle).
            console.error(`WAHA connection check failed for config ${config.id}:`, err)
            return {
              id: config.id,
              connected: false,
              status: 'disconnected' as const,
              provider: 'waha',
              session_status: 'UNKNOWN',
              waha_session: config.waha_session,
              waha_url: config.waha_url,
              flow_id: config.flow_id,
              receptivo: config.receptivo,
              habilitado: config.habilitado,
              team_id: config.team_id,
              reason: 'waha_api_error',
              message: 'Não foi possível conectar ao servidor WAHA. Confira a URL configurada e tente de novo.',
              phone_info: {
                id: config.waha_session,
                display_phone_number: config.waha_session,
                verified_name: `WAHA: ${config.waha_session} (Error)`
              }
            }
          }
        } else {
          // Meta provider
          let accessToken: string
          try {
            accessToken = decryptStoredSecret(config.access_token, 'whatsapp_config.access_token')
          } catch (err) {
            return {
              id: config.id,
              connected: false,
              status: 'disconnected' as const,
              provider: 'meta',
              flow_id: config.flow_id,
              receptivo: config.receptivo,
              habilitado: config.habilitado,
              team_id: config.team_id,
              has_app_secret: !!config.app_secret,
              reason: 'token_corrupted',
              needs_reset: true,
              message: 'O token de acesso salvo não pode ser decifrado.'
            }
          }

          try {
            const phoneInfo = await verifyPhoneNumber({
              phoneNumberId: config.phone_number_id,
              accessToken,
            })

            // 'warning' — token verifies fine (connected), but the last
            // /register call (webhook routing) failed, so inbound
            // messages may not actually reach this app even though the
            // channel "looks" healthy.
            const hasRegistrationError = !!config.last_registration_error
            return {
              id: config.id,
              connected: true,
              status: (hasRegistrationError ? 'warning' : 'connected') as 'connected' | 'warning',
              warning_reason: hasRegistrationError ? 'registration_error' : undefined,
              warning_message: hasRegistrationError ? 'Erro de registro detectado' : undefined,
              provider: 'meta',
              flow_id: config.flow_id,
              receptivo: config.receptivo,
              habilitado: config.habilitado,
              team_id: config.team_id,
              client_id: config.client_id ?? null,
              // Só o indicador — o segredo (nem cifrado) nunca vai pro cliente.
              has_app_secret: !!config.app_secret,
              phone_info: phoneInfo
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Erro desconhecido da API da Meta'
            return {
              id: config.id,
              connected: false,
              status: 'disconnected' as const,
              provider: 'meta',
              flow_id: config.flow_id,
              receptivo: config.receptivo,
              habilitado: config.habilitado,
              team_id: config.team_id,
              client_id: config.client_id ?? null,
              has_app_secret: !!config.app_secret,
              reason: 'meta_api_error',
              message: `A API da Meta rejeitou as credenciais: ${message}`
            }
          }
        }
      })
    )

    const isAnyConnected = configsWithStatus.some(c => c.connected)
    const primary = configsWithStatus[0]

    return NextResponse.json({
      connected: isAnyConnected,
      configs: configsWithStatus,
      provider: primary.provider,
      session_status: (primary as any).session_status || undefined,
      phone_info: primary.phone_info,
      reason: !isAnyConnected ? (primary as any).reason || 'disconnected' : undefined,
      message: !isAnyConnected ? (primary as any).message || 'Não conectado' : undefined
    })

  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Erro interno do servidor' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config for the authenticated user.
 * Verifies credentials with Meta first, then encrypts and stores.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Seu perfil não está vinculado a uma conta.' },
        { status: 403 },
      )
    }

    // Gravação dos segredos do canal passa pelo service role (a migration
    // 153 tira INSERT/UPDATE dessas colunas do papel authenticated) — então
    // o "só admin" que antes vinha da RLS (whatsapp_config_insert/update,
    // is_account_member(account_id, 'admin')) é checado aqui.
    const { data: roleRow } = await supabase
      .from('profiles')
      .select('account_role')
      .eq('user_id', user.id)
      .maybeSingle()
    const callerRole = (roleRow as { account_role?: string } | null)?.account_role
    if (!callerRole || !isAccountRole(callerRole) || !can({ role: callerRole }, 'channels.manage')) {
      return NextResponse.json(
        { error: 'Somente administradores da conta podem alterar as configurações dos canais.' },
        { status: 403 },
      )
    }
    const writer = supabaseAdmin()

    const body = await request.json()
    const { id: configId, provider = 'meta', waha_url, waha_session, waha_api_key, phone_number_id, waba_id, access_token, app_secret, verify_token, pin, team_id } = body
    const useExistingSession = body.use_existing_session === true

    const MASKED_TOKEN = '••••••••••••••••'

    // Same reasoning as the PATCH handler's team_id check — a channel
    // pointed at another account's team would leak which team it routes
    // conversations to across the account boundary. Only validated when
    // provided and non-null; omitted (undefined) leaves the column
    // untouched on an update, per the `team_id: ... : undefined` spread
    // below (JSON.stringify drops undefined keys, so the column is
    // simply not part of the PATCH-equivalent update payload).
    if (team_id) {
      const { data: team, error: teamError } = await supabase
        .from('teams')
        .select('id')
        .eq('id', team_id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (teamError) {
        console.error('Error validating team_id ownership:', teamError)
        return NextResponse.json({ error: 'Falha ao validar a equipe' }, { status: 500 })
      }
      if (!team) {
        return NextResponse.json({ error: 'Equipe não encontrada na sua conta' }, { status: 404 })
      }
    }

    if (provider === 'waha') {
      // waha_url é do tenant: precisa ser pública (ou estar em SSRF_ALLOWED_HOSTS). Validada
      // aqui no cadastro E a cada chamada (wahaFetch → safeFetch). PRD 14, SW-1.
      if (typeof waha_url === 'string' && waha_url) {
        try {
          await assertWahaUrlIsSafe(waha_url)
        } catch (err) {
          if (err instanceof WahaUrlBlockedError) {
            return NextResponse.json({ error: 'waha_url não é permitida.' }, { status: 400 })
          }
          throw err
        }
      }

      if (!waha_url || !waha_session) {
        return NextResponse.json(
          { error: 'waha_url e waha_session são obrigatórios' },
          { status: 400 }
        )
      }

      // The client normalizes waha_session to this same format, but that's
      // only a UX nicety — a caller hitting this API directly could send
      // anything, and the value is later interpolated into WAHA URL paths.
      if (!/^[a-z0-9_-]+$/.test(waha_session)) {
        return NextResponse.json(
          { error: 'waha_session deve corresponder a ^[a-z0-9_-]+$' },
          { status: 400 }
        )
      }

      // Check if another account has already claimed this waha_session
      const { data: claimed, error: claimedError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('account_id')
        .eq('waha_session', waha_session)
        .neq('account_id', accountId)
        .maybeSingle()

      if (claimedError) {
        console.error('Error checking waha_session ownership:', claimedError.message)
        return NextResponse.json(
          { error: 'Falha ao validar a configuração' },
          { status: 500 }
        )
      }

      if (claimed) {
        return NextResponse.json(
          {
            error:
              'Esta sessão WAHA já está vinculada a outra conta nesta instância.',
          },
          { status: 409 }
        )
      }

      // Encrypt api key if provided
      let encryptedApiKey: string | null = null
      if (waha_api_key && waha_api_key !== MASKED_TOKEN) {
        try {
          encryptedApiKey = encrypt(waha_api_key)
        } catch (err) {
          console.error('Encryption failed:', err)
          return NextResponse.json(
            { error: 'Falha ao cifrar a chave de API.' },
            { status: 500 }
          )
        }
      }

      // Upsert configuration in DB
      const wahaConfigObj: Record<string, any> = {
        provider: 'waha',
        waha_url,
        waha_session,
        phone_number_id: waha_session, // Map phone_number_id to session for unique check/compat
        access_token: 'waha-placeholder', // Mock access_token for not null constraints
        status: 'disconnected', // Initially disconnected, user starts it manually
        account_id: accountId,
        user_id: user.id,
        // Omitted (undefined) when not sent — JSON.stringify drops it,
        // so an edit that doesn't touch team assignment leaves the
        // existing column alone instead of nulling it out.
        team_id: team_id !== undefined ? (team_id || null) : undefined,
      }

      let existing = null
      if (configId) {
        const { data } = await supabaseAdmin()
          .from('whatsapp_config')
          .select('id, waha_api_key')
          .eq('id', configId)
          .eq('account_id', accountId)
          .maybeSingle()
        existing = data
      } else {
        const { data } = await supabaseAdmin()
          .from('whatsapp_config')
          .select('id, waha_api_key')
          .eq('account_id', accountId)
          .eq('waha_session', waha_session)
          .maybeSingle()
        existing = data
      }

      // id do canal salvo — define a URL e o segredo do webhook WAHA.
      let savedConfigId: string | null = existing?.id ?? null

      if (existing) {
        if (waha_api_key === MASKED_TOKEN) {
          // Mantém a chave atual — cifrando-a se ainda estiver em texto puro legado.
          wahaConfigObj.waha_api_key = existing.waha_api_key
            ? ensureEncryptedSecret(existing.waha_api_key)
            : existing.waha_api_key
        } else {
          wahaConfigObj.waha_api_key = encryptedApiKey
        }

        const { error: updateError } = await writer
          .from('whatsapp_config')
          .update(wahaConfigObj)
          .eq('id', existing.id)
          .eq('account_id', accountId)

        if (updateError) {
          console.error('Error updating config:', updateError)
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }
      } else {
        wahaConfigObj.waha_api_key = encryptedApiKey
        const { data: inserted, error: insertError } = await writer
          .from('whatsapp_config')
          .insert(wahaConfigObj)
          .select('id')
          .limit(1)
        savedConfigId = (inserted?.[0]?.id as string | undefined) ?? null

        if (insertError) {
          console.error('Error inserting config:', insertError)
          return NextResponse.json({ error: insertError.message }, { status: 500 })
        }
      }

      if (!useExistingSession) {
        // Auto-start the session in WAHA (stops/recreates it to apply
        // the webhook config — see startWahaSession).
        try {
          const rawApiKey = waha_api_key === MASKED_TOKEN && existing
            ? (existing.waha_api_key ? decryptStoredSecret(existing.waha_api_key, 'whatsapp_config.waha_api_key') : null)
            : waha_api_key

          if (!savedConfigId) throw new Error('ID da configuração WAHA salva não encontrado')

          // URL a partir de env confiável (nunca de Host/X-Forwarded-Host) e
          // segredo derivado por canal — o segredo global não vai para o WAHA.
          await startWahaSession({
            waha_url,
            waha_session,
            waha_api_key: rawApiKey && rawApiKey !== MASKED_TOKEN ? rawApiKey : null
          }, wahaWebhookFor(savedConfigId))
        } catch (err) {
          console.warn('Could not auto-start WAHA session:', err)
        }
      } else {
        // Sessão existente — não recria nem reinicia, só avisa no log
        // se ela não estiver WORKING no servidor WAHA.
        try {
          const rawApiKey = waha_api_key === MASKED_TOKEN && existing
            ? (existing.waha_api_key ? decryptStoredSecret(existing.waha_api_key, 'whatsapp_config.waha_api_key') : null)
            : waha_api_key

          const sessionInfo = await getWahaSessionInfo({
            waha_url,
            waha_session,
            waha_api_key: rawApiKey && rawApiKey !== MASKED_TOKEN ? rawApiKey : null,
          })
          if (sessionInfo?.status !== 'WORKING') {
            console.warn('[WAHA] Sessão existente não está WORKING:', sessionInfo?.status)
          }
        } catch (err) {
          console.warn('[WAHA] Não foi possível verificar sessão existente:', err)
        }
      }

      return NextResponse.json({ success: true, message: 'Configuração do WAHA salva.' })
    }

    if (!phone_number_id) {
      return NextResponse.json(
        { error: 'phone_number_id é obrigatório' },
        { status: 400 }
      )
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'O PIN deve ter exatamente 6 dígitos.' },
          { status: 400 }
        )
      }
    }

    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Falha ao validar a configuração' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'Este número de WhatsApp já está vinculado a outra conta nesta instância. Cada número só pode ser conectado a um usuário do wacrm.',
        },
        { status: 409 }
      )
    }

    // Look up any pre-existing row for this account so we know whether
    // this number is already registered with Meta — if so we can skip
    // /register when the user didn't provide a PIN this time around,
    // and whether there's a stored access_token to fall back on below.
    let existing = null
    if (configId) {
      const { data } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('id, registered_at, phone_number_id, access_token, app_secret, verify_token')
        .eq('id', configId)
        .eq('account_id', accountId)
        .maybeSingle()
      existing = data
    } else {
      const { data } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('id, registered_at, phone_number_id, access_token, app_secret, verify_token')
        .eq('account_id', accountId)
        .eq('phone_number_id', phone_number_id)
        .maybeSingle()
      existing = data
    }

    // Resolve the access token to actually use, mirroring the
    // waha_api_key === MASKED_TOKEN pattern above: a masked/omitted
    // token on an update means "keep the current one" rather than "no
    // token provided". `effectiveAccessToken` (plaintext) is what the
    // live Meta API calls below need; `encryptedAccessToken` is what
    // gets persisted.
    let effectiveAccessToken: string
    let encryptedAccessToken: string
    if ((!access_token || access_token === MASKED_TOKEN) && existing?.access_token) {
      try {
        effectiveAccessToken = decryptStoredSecret(existing.access_token, 'whatsapp_config.access_token')
        // Texto puro legado é cifrado aqui mesmo, no save.
        encryptedAccessToken = ensureEncryptedSecret(existing.access_token)
      } catch (err) {
        console.error('Failed to decrypt existing access_token:', err)
        return NextResponse.json(
          { error: 'O token de acesso salvo não pode ser decifrado. Informe-o novamente.' },
          { status: 500 }
        )
      }
    } else if (access_token && access_token !== MASKED_TOKEN) {
      effectiveAccessToken = access_token
      try {
        encryptedAccessToken = encrypt(access_token)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erro desconhecido de criptografia'
        console.error('Encryption failed:', message)
        return NextResponse.json(
          {
            error:
              'Falha ao cifrar o token. Confira se ENCRYPTION_KEY é uma string hexadecimal válida de 64 caracteres nas variáveis de ambiente.',
          },
          { status: 500 }
        )
      }
    } else {
      return NextResponse.json(
        { error: 'access_token e phone_number_id são obrigatórios' },
        { status: 400 }
      )
    }

    // app_secret — used by the webhook to HMAC-verify inbound payloads
    // per channel. O GET nunca devolve o segredo (só `has_app_secret`),
    // então campo omitido/vazio — ou a máscara de bolinhas — significa
    // "manter o atual". Valor novo é SEMPRE cifrado aqui no servidor, e
    // um valor atual ainda em texto puro legado é cifrado no próprio
    // save (ver resolveSecretForWrite).
    // Required on first save — a Meta channel with no app_secret and no
    // process.env.META_APP_SECRET fallback can never pass the webhook's
    // signature check, so failing here beats a silently broken channel.
    let encryptedAppSecret: string | null
    try {
      const resolved = resolveSecretForWrite(app_secret, existing?.app_secret)
      if (!resolved.ok) {
        return NextResponse.json(
          { error: 'app_secret deve ser um texto' },
          { status: 400 }
        )
      }
      encryptedAppSecret = resolved.value
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido de criptografia'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Falha ao cifrar o App Secret. Confira se ENCRYPTION_KEY é uma string hexadecimal válida de 64 caracteres nas variáveis de ambiente.',
        },
        { status: 500 }
      )
    }
    if (!encryptedAppSecret && !existing) {
      return NextResponse.json(
        { error: 'app_secret é obrigatório' },
        { status: 400 }
      )
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: effectiveAccessToken,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido da API da Meta'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json(
        { error: `Erro da API da Meta: ${message}` },
        { status: 400 }
      )
    }

    // verify_token — same "keep existing on blank" pattern as
    // access_token/app_secret above. Previously any edit that didn't
    // retype this field (the GET response never returns it, so
    // EditChannelDialog always starts it blank) silently nulled out an
    // already-configured verify_token.
    let encryptedVerifyToken: string | null
    try {
      const resolved = resolveSecretForWrite(verify_token, existing?.verify_token)
      if (!resolved.ok) {
        return NextResponse.json(
          { error: 'verify_token deve ser um texto' },
          { status: 400 }
        )
      }
      encryptedVerifyToken = resolved.value
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido de criptografia'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Falha ao cifrar o token. Confira se ENCRYPTION_KEY é uma string hexadecimal válida de 64 caracteres nas variáveis de ambiente.',
        },
        { status: 500 }
      )
    }

    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: effectiveAccessToken,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Erro desconhecido da API da Meta'
          console.error('Phone number /register failed:', registrationError)
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: effectiveAccessToken,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('WABA subscribed_apps failed (non-fatal):', message)
        // Subscription failures are rare once the App has the right
        // permissions; we don't block save on them — the diagnostic
        // endpoint surfaces this state too.
      }
    }

    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      app_secret: encryptedAppSecret,
      verify_token: encryptedVerifyToken,
      display_phone_number: phoneInfo.display_phone_number ?? null,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
      // Same "omitted means untouched" behavior as the WAHA branch above.
      team_id: team_id !== undefined ? (team_id || null) : undefined,
    }

    if (existing) {
      const { error: updateError } = await writer
        .from('whatsapp_config')
        .update(baseRow)
        .eq('id', existing.id)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Falha ao atualizar a configuração' },
          { status: 500 }
        )
      }
    } else {
      // Insert with both columns: `account_id` is the tenancy key
      // (NOT NULL post-017, UNIQUE so duplicates trip the constraint
      // up-front), `user_id` is the audit column identifying which
      // member of the account saved the config.
      const { error: insertError } = await writer
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...baseRow,
        })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Falha ao salvar a configuração' },
          { status: 500 }
        )
      }
    }

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * If target ID is specified in query string, deletes that specific line.
 */
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Seu perfil não está vinculado a uma conta.' },
        { status: 403 },
      )
    }

    const denied = await requireChannelAdmin(supabase, user.id, 'Somente administradores da conta podem excluir canais.')
    if (denied) return denied

    const { searchParams } = new URL(request.url)
    const targetId = searchParams.get('id')

    const query = supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (targetId) {
      query.eq('id', targetId)
    }

    const { error: deleteError } = await query

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Falha ao excluir a configuração' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

/**
 * PATCH /api/whatsapp/config
 *
 * Partial update for the /canais table's inline toggles (flow_id,
 * receptivo, habilitado) — added alongside those columns (migration
 * 056). There is no PUT on this route, and reusing POST for a toggle
 * isn't viable: POST always requires access_token/phone_number_id for
 * Meta, and the client never holds the plaintext token to resend (it
 * only ever sees the masked placeholder). This handler only ever
 * touches the three settings columns, never the provider credentials.
 */
export async function PATCH(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Seu perfil não está vinculado a uma conta.' },
        { status: 403 },
      )
    }

    const denied = await requireChannelAdmin(supabase, user.id, 'Somente administradores da conta podem alterar as configurações dos canais.')
    if (denied) return denied

    const body = await request.json()
    const { id, flow_id, receptivo, habilitado, team_id, client_id } = body

    if (!id) {
      return NextResponse.json({ error: 'id é obrigatório' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}
    if (flow_id !== undefined) update.flow_id = flow_id
    if (receptivo !== undefined) update.receptivo = receptivo
    if (habilitado !== undefined) update.habilitado = habilitado
    if (team_id !== undefined) update.team_id = team_id
    // Cliente da linha (migration 128): selo e filtro no inbox.
    if (client_id !== undefined) update.client_id = client_id

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: 'Informe ao menos um destes campos: flow_id, receptivo, habilitado, team_id, client_id' },
        { status: 400 },
      )
    }

    if (typeof update.receptivo !== 'undefined' && typeof update.receptivo !== 'boolean') {
      return NextResponse.json({ error: 'receptivo deve ser verdadeiro ou falso' }, { status: 400 })
    }
    if (typeof update.habilitado !== 'undefined' && typeof update.habilitado !== 'boolean') {
      return NextResponse.json({ error: 'habilitado deve ser verdadeiro ou falso' }, { status: 400 })
    }

    // flow_id, when set (not null), must belong to the caller's own
    // account — otherwise a channel could be pointed at another
    // account's flow, which whatever eventually consumes flow_id
    // would then execute cross-account.
    if (update.flow_id) {
      const { data: flow, error: flowError } = await supabase
        .from('flows')
        .select('id')
        .eq('id', update.flow_id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (flowError) {
        console.error('Error validating flow_id ownership:', flowError)
        return NextResponse.json({ error: 'Falha ao validar o fluxo' }, { status: 500 })
      }
      if (!flow) {
        return NextResponse.json({ error: 'Fluxo não encontrado na sua conta' }, { status: 404 })
      }
    }

    // Same reasoning as flow_id above — a channel pointed at another
    // account's team would leak which team it routes conversations to
    // (or worse, once something downstream acts on it) across the
    // account boundary.
    if (update.team_id) {
      const { data: team, error: teamError } = await supabase
        .from('teams')
        .select('id')
        .eq('id', update.team_id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (teamError) {
        console.error('Error validating team_id ownership:', teamError)
        return NextResponse.json({ error: 'Falha ao validar a equipe' }, { status: 500 })
      }
      if (!team) {
        return NextResponse.json({ error: 'Equipe não encontrada na sua conta' }, { status: 404 })
      }
    }

    if (update.client_id) {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('id', update.client_id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!client) {
        return NextResponse.json({ error: 'Cliente não encontrado na sua conta' }, { status: 404 })
      }
    }

    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)

    if (updateError) {
      console.error('Error updating whatsapp_config (PATCH):', updateError)
      return NextResponse.json({ error: 'Falha ao atualizar a configuração' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config PATCH:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
