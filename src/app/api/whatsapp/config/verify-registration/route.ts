import { NextResponse } from 'next/server'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means the
 *                    number was saved but never actually subscribed
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET() {
  // Diagnóstico que chama a Graph API com o token da conta: só quem gere canais (channels.manage). Contexto completo
  // (revisão de segurança 13/10, item 6): papel personalizado, ajuste do cargo, membro desativado e 2FA. Antes: só sessão.
  let supabase: Awaited<ReturnType<typeof requirePermission>>['supabase']
  let accountId: string
  try {
    const ctx = await requirePermission('channels.manage')
    supabase = ctx.supabase
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  // Segredos só pelo servidor (migration 200b); visibilidade = RLS do usuário.
  // Exatamente 1 canal, como o .maybeSingle() anterior (vários = sem config).
  const { data: configRows } = await fetchChannelConfigs(supabase, accountId, (q) => q.eq('account_id', accountId))
  const config = configRows?.length === 1 ? (configRows[0] as any) : null

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'Nenhuma configuração de WhatsApp salva ainda.',
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        'O token de acesso salvo não pode ser decifrado — provavelmente a ENCRYPTION_KEY mudou. Informe o token novamente para reparar.',
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    waba_subscribed_to_app: boolean | null
    locally_marked_registered: boolean
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
  }
  const errors: string[] = []

  // 1. Phone metadata
  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    checks.phone_metadata_ok = true
  } catch (err) {
    errors.push(
      `Falha ao verificar os metadados do telefone: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      })
      // Meta returns the apps subscribed to this WABA. If the list
      // is non-empty, OUR app is in there (the access_token we used
      // belongs to our app — Meta wouldn't return data for an app
      // the token can't see). Treat any entry as success.
      checks.waba_subscribed_to_app = subs.length > 0
      if (!checks.waba_subscribed_to_app) {
        errors.push(
          'A WABA não tem apps inscritos. Salve a configuração de novo para inscrever.',
        )
      }
    } catch (err) {
      errors.push(
        `Falha ao verificar a assinatura da WABA: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    errors.push(
      'Não há ID da WABA salvo — os webhooks não funcionam sem ele. Informe-o no formulário e salve de novo.',
    )
  }

  const live =
    checks.phone_metadata_ok &&
    (checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered

  return NextResponse.json({
    live,
    checks,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  })
}
