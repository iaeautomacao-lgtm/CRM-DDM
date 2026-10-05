import { createHmac } from 'node:crypto'
import { headers } from 'next/headers'

// Contexto de auditoria por requisição (migration 131).
//
// As triggers de auditoria leem "quem fez" de wacrm.audit_actor(). Para
// escritas feitas pelo NOSSO servidor com o service role, o banco não
// sabe quem é o usuário — então todo cliente Supabase do servidor usa
// `auditFetch`, que anexa headers x-audit-* (usuário, IP, navegador,
// origem). O banco só confia nesses headers quando o JWT é service_role,
// ou — no cliente SSR, que usa o JWT do usuário — quando vêm assinados
// (x-audit-sig, HMAC com AUDIT_HEADER_SECRET = wacrm.audit_secrets).
//
// De onde vem o usuário: `registerAuditActor` é chamado depois que
// `supabase.auth.getUser()` validou a sessão (wrapper em
// src/lib/supabase/server.ts, usado por getCurrentAccount e pelas rotas
// que chamam getUser direto). Nunca a partir de dado não verificado.
//
// Escopo da requisição: o objeto devolvido por `headers()` do Next é o
// mesmo durante toda a requisição (inclusive em after()), então serve de
// chave num WeakMap — some sozinho quando a requisição acaba. Fora de uma
// requisição (testes, scripts) headers() lança e nada é anexado.

export type AuditActorType = 'user' | 'system' | 'webhook' | 'automation' | 'flow' | 'ai' | 'api'

export interface AuditActor {
  userId?: string
  actorType?: AuditActorType
  /** Origem livre: 'inbox', 'webhook_meta', 'cron_disparador'... */
  source?: string
  /** Observação da ação (ex.: motivo da transferência). */
  note?: string
}

const actors = new WeakMap<object, AuditActor>()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function requestHeaders(): Promise<Headers | null> {
  try {
    return (await headers()) as unknown as Headers
  } catch {
    return null
  }
}

/** Headers HTTP só aceitam ASCII visível; corta o resto. */
function headerSafe(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  const clean = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max)
  return clean || null
}

/**
 * IP do cliente atrás do proxy (EasyPanel → Passenger). x-real-ip é
 * definido pelo proxy; no x-forwarded-for vale o ÚLTIMO item, que é o que
 * o nosso proxy acrescentou — o primeiro pode ter vindo do próprio cliente.
 */
export function clientIp(h: Headers): string | null {
  const forwarded = h.get('x-forwarded-for')?.split(',').map((v) => v.trim()).filter(Boolean)
  return headerSafe(h.get('x-real-ip') || forwarded?.[forwarded.length - 1] || null, 64)
}

/** Página de onde veio a ação (/inbox, /disparador...) a partir do Referer. */
function sourceFromReferer(h: Headers): string | null {
  const referer = h.get('referer')
  if (!referer) return null
  try {
    const segment = new URL(referer).pathname.split('/').filter(Boolean)[0]
    return segment ? headerSafe(segment, 40) : null
  } catch {
    return null
  }
}

/** Associa o autor (ou origem/observação) à requisição atual. */
export async function registerAuditActor(actor: AuditActor): Promise<void> {
  const h = await requestHeaders()
  if (!h) return
  if (actor.userId && !UUID_RE.test(actor.userId)) return
  actors.set(h, { ...actors.get(h), ...actor })
}

export interface AuditRequestInfo {
  userId: string | null
  actorType: AuditActorType
  source: string | null
  ip: string | null
  userAgent: string | null
  note: string | null
}

/** Autor + IP + navegador da requisição atual (null fora de requisição). */
export async function currentAuditInfo(): Promise<AuditRequestInfo | null> {
  const h = await requestHeaders()
  if (!h) return null
  const actor = actors.get(h) ?? {}
  return {
    userId: actor.userId ?? null,
    actorType: actor.actorType ?? (actor.userId ? 'user' : 'system'),
    source: headerSafe(actor.source, 60) ?? sourceFromReferer(h),
    ip: clientIp(h),
    userAgent: headerSafe(h.get('user-agent'), 300),
    note: actor.note ?? null,
  }
}

/** Headers x-audit-* para a requisição atual ao PostgREST. */
export async function auditHeaders(): Promise<Record<string, string>> {
  const info = await currentAuditInfo()
  if (!info) return {}
  const out: Record<string, string> = { 'x-audit-actor-type': info.actorType }
  if (info.userId) out['x-audit-user-id'] = info.userId
  if (info.ip) out['x-audit-ip'] = info.ip
  if (info.userAgent) out['x-audit-user-agent'] = info.userAgent
  if (info.source) out['x-audit-source'] = info.source
  // Observação pode ter acento: vai codificada. Corta ANTES de codificar
  // para não partir uma sequência %XX (o banco decodifica).
  if (info.note) out['x-audit-note'] = encodeURIComponent(info.note.slice(0, 300))
  const sig = signAuditHeaders(out)
  if (sig) out['x-audit-sig'] = sig
  return out
}

/**
 * Assinatura conferida por wacrm.audit_actor() quando a requisição usa o
 * JWT do usuário: HMAC-SHA256(user\nip\nuser-agent\nsource), pulando os
 * vazios (concat_ws no SQL). Sem AUDIT_HEADER_SECRET não assina e o banco
 * usa o IP que ele mesmo viu.
 */
export function signAuditHeaders(h: Record<string, string>): string | null {
  const secret = process.env.AUDIT_HEADER_SECRET
  if (!secret || !h['x-audit-user-id']) return null
  const payload = [h['x-audit-user-id'], h['x-audit-ip'], h['x-audit-user-agent'], h['x-audit-source']]
    .filter((v) => v !== undefined && v !== null)
    .join('\n')
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/** fetch dos clientes Supabase do servidor: anexa os headers de auditoria. */
export const auditFetch: typeof fetch = async (input, init) => {
  const extra = await auditHeaders()
  if (Object.keys(extra).length === 0) return fetch(input, init)
  const merged = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  for (const [key, value] of Object.entries(extra)) {
    if (!merged.has(key)) merged.set(key, value)
  }
  return fetch(input, { ...init, headers: merged })
}
