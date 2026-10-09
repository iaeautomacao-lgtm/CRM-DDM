// WhatsApp Calling (PRD 18, PR-18.1) — SÓ dados: ingestão do webhook `calls` da Meta (CDR) e controle de Call Permission.
// SEM áudio/WebRTC (gateway = PR-18.2+). Tudo aqui é best-effort: um evento de chamada que falha NUNCA derruba o POST do webhook, e sem as
// migrations 250/251 (funções/tabelas ausentes) o evento é ignorado e o resto do webhook segue.
//
// Contrato da Meta (campo `calls`): value.calls[] = { id, from, to, event: connect|terminate, direction: USER_INITIATED|BUSINESS_INITIATED,
// timestamp, start_time?, end_time?, duration?, status?, errors? } e value.statuses[] = { id, status: RINGING|ACCEPTED|REJECTED, timestamp }.
// Os nomes do PRD (connect_request, ringing, connected, ended, rejected, missed) também são aceitos. Resposta de permissão: mensagem
// interactive `call_permission_reply` { response: accept|reject, is_permanent, expiration_timestamp }.

import { normalizePhone } from '@/lib/whatsapp/phone-utils'

export type CallDirection = 'inbound' | 'outbound'
export type CallStatus = 'initiated' | 'ringing' | 'connected' | 'ended' | 'missed' | 'rejected' | 'failed' | 'busy'

export interface CallEvent {
  metaCallId: string
  direction: CallDirection | null
  status: CallStatus
  /** Telefone do CLIENTE (só dígitos); null quando o evento não traz (status avulso). */
  phone: string | null
  eventTs: number | null
  startTs: number | null
  endTs: number | null
  duration: number | null
  cause: string | null
  /** true = evento da lista `calls` (pode criar a chamada); false = status avulso (só atualiza uma que já existe). */
  canCreate: boolean
}

interface MetaCall {
  id?: unknown
  from?: unknown
  to?: unknown
  event?: unknown
  direction?: unknown
  status?: unknown
  timestamp?: unknown
  start_time?: unknown
  end_time?: unknown
  duration?: unknown
  errors?: Array<{ code?: unknown; message?: unknown; title?: unknown }>
}

export interface CallsValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string }
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
  calls?: MetaCall[]
  statuses?: Array<{ id?: unknown; status?: unknown; timestamp?: unknown; recipient_id?: unknown }>
}

const secs = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '')

function directionOf(v: unknown): CallDirection | null {
  const d = lower(v)
  if (d === 'user_initiated' || d === 'inbound') return 'inbound'
  if (d === 'business_initiated' || d === 'outbound') return 'outbound'
  return null
}

/** Estado do CDR para o evento/status da Meta; null = não é um estado que a gente acompanha. */
export function callStatusOf(event: unknown, status: unknown): CallStatus | null {
  const e = lower(event)
  const s = lower(status)
  if (e === 'terminate' || e === 'ended') {
    if (s === 'failed') return 'failed'
    if (s === 'rejected') return 'rejected'
    if (s === 'busy') return 'busy'
    if (s === 'missed' || s === 'no_answer') return 'missed'
    return 'ended'
  }
  if (e === 'connect' || e === 'connect_request') return 'ringing'
  if (e === 'ringing') return 'ringing'
  if (e === 'connected' || e === 'accepted') return 'connected'
  if (e === 'rejected') return 'rejected'
  if (e === 'missed') return 'missed'
  if (e === 'busy') return 'busy'
  if (e === 'failed') return 'failed'
  // statuses[] avulsos: RINGING / ACCEPTED / REJECTED
  if (!e) {
    if (s === 'ringing') return 'ringing'
    if (s === 'accepted' || s === 'connected') return 'connected'
    if (s === 'rejected') return 'rejected'
    if (s === 'failed') return 'failed'
  }
  return null
}

function causeOf(call: MetaCall): string | null {
  const err = call.errors?.[0]
  if (err) {
    const text = [err.code, err.title ?? err.message].filter((x) => x !== undefined && x !== null && x !== '').join(': ')
    if (text) return String(text).slice(0, 200)
  }
  const s = lower(call.status)
  return s === 'failed' || s === 'rejected' || s === 'busy' ? s : null
}

/** Eventos de chamada de UMA change `calls` (pura). Ignora o que não for reconhecível. */
export function extractCallEvents(value: CallsValue | null | undefined): CallEvent[] {
  const events: CallEvent[] = []
  const fallbackPhone = normalizeOrNull(value?.contacts?.[0]?.wa_id)

  for (const call of value?.calls ?? []) {
    const metaCallId = typeof call?.id === 'string' ? call.id.trim() : ''
    if (!metaCallId) continue
    const duration = secs(call.duration)
    const status = callStatusOf(call.event, call.status)
    if (!status) continue
    const direction = directionOf(call.direction)
    // O telefone do CLIENTE: em chamada recebida é o `from`; em chamada do negócio é o `to`.
    const customer = direction === 'outbound' ? call.to : call.from
    events.push({
      metaCallId,
      direction,
      status,
      phone: normalizeOrNull(customer) ?? fallbackPhone,
      eventTs: secs(call.timestamp),
      startTs: secs(call.start_time),
      endTs: secs(call.end_time),
      duration,
      cause: causeOf(call),
      canCreate: true,
    })
  }

  for (const st of value?.statuses ?? []) {
    const metaCallId = typeof st?.id === 'string' ? st.id.trim() : ''
    const status = callStatusOf(undefined, st?.status)
    if (!metaCallId || !status) continue
    events.push({
      metaCallId, direction: null, status, phone: normalizeOrNull(st.recipient_id),
      eventTs: secs(st.timestamp), startTs: null, endTs: null, duration: null, cause: null, canCreate: false,
    })
  }
  return events
}

function normalizeOrNull(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const p = normalizePhone(String(v))
  return p && /^[0-9]{8,20}$/.test(p) ? p : null
}

const iso = (s: number | null): string | null => (s ? new Date(s * 1000).toISOString() : null)

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
export type CallsDb = { rpc: (fn: string, args?: Record<string, unknown>) => RpcResult }

export function isMissingCallsSchema(error: { code?: string; message?: string } | null): boolean {
  return (
    error?.code === 'PGRST202' || error?.code === '42883' || error?.code === '42P01' || error?.code === '42703' ||
    /could not find the function|does not exist/i.test(error?.message ?? '')
  )
}

/** Janela de retorno depois que o cliente LIGA para o negócio (permissão implícita curta). Constante do código; ajustável quando a Meta/dono definir. */
export const INBOUND_CALL_PERMISSION_HOURS = 72
/** Permissão temporária concedida pelo cliente (resposta sem `expiration_timestamp`). */
export const TEMPORARY_PERMISSION_DAYS = 7

export interface CallContext {
  contactId: string
  conversationId: string
}

export interface ProcessCallsDeps {
  db: CallsDb
  accountId: string
  channelId: string
  /** Acha/cria contato e conversa do telefone (usa os mesmos helpers do inbound de mensagens). */
  resolveContext: (phone: string, name: string) => Promise<CallContext | null>
  now?: () => number
}

export interface ProcessCallsSummary {
  applied: number
  ignored: number
  failed: number
  /** true = migration 250 ausente (eventos ignorados). */
  missing: boolean
}

/** Aplica os eventos de uma change `calls`. Nunca lança; erro de um evento não impede os demais. */
export async function processCallEvents(value: CallsValue, deps: ProcessCallsDeps): Promise<ProcessCallsSummary> {
  const summary: ProcessCallsSummary = { applied: 0, ignored: 0, failed: 0, missing: false }
  const name = String(value.contacts?.[0]?.profile?.name ?? '').trim()
  const now = deps.now ?? Date.now

  for (const ev of extractCallEvents(value)) {
    try {
      let ctx: CallContext | null = null
      if (ev.canCreate && ev.phone && ev.direction) {
        ctx = await deps.resolveContext(ev.phone, name)
      }
      const { data, error } = await deps.db.rpc('apply_call_event', {
        p_account_id: deps.accountId,
        p_channel_id: deps.channelId,
        p_conversation_id: ctx?.conversationId ?? null,
        p_contact_id: ctx?.contactId ?? null,
        p_meta_call_id: ev.metaCallId,
        // Status avulso (sem direção) só atualiza chamada existente; a direção real fica na linha.
        p_direction: ev.direction ?? 'inbound',
        p_status: ev.status,
        p_event_ts: iso(ev.eventTs),
        p_start_ts: iso(ev.startTs),
        p_end_ts: iso(ev.endTs),
        p_duration: ev.duration,
        p_cause: ev.cause,
      })
      if (error) {
        if (isMissingCallsSchema(error)) {
          summary.missing = true
          return summary
        }
        summary.failed++
        console.error('[calls] falha ao aplicar evento de chamada:', error.message)
        continue
      }
      const result = (data as { result?: string } | null)?.result
      if (result === 'created' || result === 'updated') summary.applied++
      else summary.ignored++

      // Cliente LIGOU para o negócio: abre uma janela curta para o retorno (não exige pedido de permissão).
      if (ev.direction === 'inbound' && ev.status === 'ringing' && ev.phone && ctx) {
        const granted = (ev.eventTs ?? Math.floor(now() / 1000)) * 1000
        await recordCallPermission(deps.db, {
          accountId: deps.accountId,
          contactId: ctx.contactId,
          phone: ev.phone,
          grantedAt: new Date(granted),
          expiresAt: new Date(granted + INBOUND_CALL_PERMISSION_HOURS * 3_600_000),
          source: 'inbound_call',
        })
      }
    } catch (e) {
      summary.failed++
      console.error('[calls] erro inesperado ao processar evento de chamada:', e instanceof Error ? e.message : e)
    }
  }
  return summary
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Call Permission

export type CallPermissionSource = 'inbound_call' | 'template_button' | 'interactive_optin' | 'explicit_chat'

export interface RecordPermissionInput {
  accountId: string
  contactId: string | null
  phone: string
  grantedAt: Date
  /** Date(8.64e15) = permanente ('infinity' no banco); no passado = recusada/revogada. */
  expiresAt: Date | 'infinity'
  source: CallPermissionSource
}

/** Grava a permissão (idempotente; evento atrasado não sobrescreve um mais novo). Nunca lança; sem a 251, devolve false. */
export async function recordCallPermission(db: CallsDb, input: RecordPermissionInput): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('record_call_permission', {
      p_account_id: input.accountId,
      p_contact_id: input.contactId,
      p_phone: input.phone,
      p_granted_at: input.grantedAt.toISOString(),
      p_expires_at: input.expiresAt === 'infinity' ? 'infinity' : input.expiresAt.toISOString(),
      p_source: input.source,
    })
    if (error) {
      if (!isMissingCallsSchema(error)) console.error('[calls] falha ao gravar a permissão de chamada:', error.message)
      return false
    }
    return data === true
  } catch (e) {
    console.error('[calls] erro ao gravar a permissão de chamada:', e instanceof Error ? e.message : e)
    return false
  }
}

export interface CallPermissionReply {
  accepted: boolean
  permanent: boolean
  /** Segundos desde epoch (expiration_timestamp da Meta) ou null. */
  expiresAt: number | null
}

/** Lê o `call_permission_reply` de uma mensagem interativa (pura). Null = a mensagem não é uma resposta de permissão. */
export function parseCallPermissionReply(interactive: unknown): CallPermissionReply | null {
  const i = interactive as { type?: unknown; call_permission_reply?: Record<string, unknown> } | null | undefined
  const r = i?.call_permission_reply
  if (!r || typeof r !== 'object') return null
  const response = lower(r.response)
  if (response !== 'accept' && response !== 'reject') return null
  return { accepted: response === 'accept', permanent: r.is_permanent === true, expiresAt: secs(r.expiration_timestamp) }
}

/** Texto legível da resposta, para o inbox. */
export function callPermissionReplyText(reply: CallPermissionReply): string {
  return reply.accepted ? 'Cliente autorizou receber ligações' : 'Cliente recusou receber ligações'
}

/** Grava a resposta do cliente: aceitou ⇒ permissão (temporária ou permanente); recusou ⇒ expira agora (revoga). */
export async function recordCallPermissionReply(
  db: CallsDb,
  input: { accountId: string; contactId: string | null; phone: string; reply: CallPermissionReply; messageTs: number | null; now?: () => number },
): Promise<boolean> {
  const nowMs = (input.now ?? Date.now)()
  const granted = new Date(input.messageTs ? input.messageTs * 1000 : nowMs)
  let expiresAt: Date | 'infinity'
  if (!input.reply.accepted) expiresAt = new Date(nowMs - 1000)
  else if (input.reply.permanent) expiresAt = 'infinity'
  else expiresAt = new Date(input.reply.expiresAt ? input.reply.expiresAt * 1000 : granted.getTime() + TEMPORARY_PERMISSION_DAYS * 86_400_000)
  return recordCallPermission(db, {
    accountId: input.accountId, contactId: input.contactId, phone: input.phone, grantedAt: granted, expiresAt, source: 'interactive_optin',
  })
}

/** RF-02: pode ligar? Chamada ativa sem permissão vigente é barrada ANTES da Meta (rotas da 18.2 usam isto). Sem a 251 ⇒ false (barra). */
export async function hasCallPermission(db: CallsDb, accountId: string, phone: string): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('has_call_permission', { p_account_id: accountId, p_phone: phone })
    return !error && data === true
  } catch {
    return false
  }
}

/** Corpo do 412 documentado no PRD 18 (RF-02), para as rotas de discagem. */
export const CALL_PERMISSION_REQUIRED_BODY = {
  ok: false,
  error: {
    code: 'call_permission_required',
    message: 'O cliente ainda não autorizou receber ligações. Envie o pedido de permissão (template com botão de chamada) e aguarde a resposta.',
  },
} as const
