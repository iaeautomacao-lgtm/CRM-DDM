import type { Permission } from '@/lib/auth/permissions'

// `access.denied` (PRD 20, 20.8): o 403 de requirePermission/requireDisparadorAccess vira um evento de auditoria com a
// permissão que faltou. Um usuário sem acesso pode repetir o pedido sem parar (tela abrindo em laço, script), então há
// DOIS limites, em memória do processo (sem infra nova; o contador reinicia no restart e é por instância — para auditoria
// de segurança isso basta):
//   - a mesma combinação conta+usuário+permissão é gravada no máximo 1× a cada 10 min;
//   - cada conta grava no máximo 20 eventos `access.denied` por minuto (varredura de permissões não inunda o log).
// NUNCA muda o resultado da rota (fire-and-forget, falha só vai para o log) e só grava com o service role configurado.

const WINDOW_MS = 10 * 60_000
const ACCOUNT_LIMIT = 20
const ACCOUNT_WINDOW_MS = 60_000
const MAX_KEYS = 5_000

const seen = new Map<string, number>()
const perAccount = new Map<string, { count: number; resetAt: number }>()

/** Só para testes. */
export function resetAccessDeniedLimits(): void {
  seen.clear()
  perAccount.clear()
}

export function shouldRecordAccessDenied(
  accountId: string,
  userId: string,
  permission: string,
  now: number = Date.now(),
): boolean {
  const key = `${accountId}:${userId}:${permission}`
  const last = seen.get(key)
  if (last !== undefined && now - last < WINDOW_MS) return false

  const bucket = perAccount.get(accountId)
  if (bucket && now < bucket.resetAt) {
    if (bucket.count >= ACCOUNT_LIMIT) return false
    bucket.count++
  } else {
    perAccount.set(accountId, { count: 1, resetAt: now + ACCOUNT_WINDOW_MS })
  }

  if (seen.size >= MAX_KEYS) {
    // varre as entradas vencidas; se ainda estiver cheio, descarta a mais antiga
    for (const [k, t] of seen) if (now - t >= WINDOW_MS) seen.delete(k)
    if (seen.size >= MAX_KEYS) seen.delete(seen.keys().next().value as string)
  }
  seen.set(key, now)
  return true
}

export interface AccessDeniedContext {
  accountId: string
  userId: string
  role: string
}

/** Registra o 403 (amostrado). Nunca lança e nunca espera: a resposta da rota não depende disto. */
export function recordAccessDenied(ctx: AccessDeniedContext, permission: Permission): void {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return
    if (!ctx.accountId || !ctx.userId) return
    if (!shouldRecordAccessDenied(ctx.accountId, ctx.userId, permission)) return
    void import('./log-event')
      .then(({ logAuditEvent }) =>
        logAuditEvent({
          accountId: ctx.accountId,
          eventType: 'action',
          resourceType: 'access',
          resourceId: ctx.userId,
          resourceLabel: permission,
          action: 'access.denied',
          summary: `Acesso negado: faltou a permissão ${permission}`,
          metadata: { permission, role: ctx.role },
        }),
      )
      .catch((err) => console.error('[audit] access.denied falhou:', err))
  } catch (err) {
    console.error('[audit] access.denied falhou:', err)
  }
}
