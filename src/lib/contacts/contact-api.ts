// Validação e serialização das rotas de contato do Inbox (PRD 23: itens 4, 5, 8 e 20). Puro (sem banco) para testar sem mocks.
import { isValidCpf, normalizeCpf } from '@/lib/ai/tool-recovery'
import { maskCpf } from '@/lib/privacy/mask'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const PHONE_RE = /^[1-9]\d{7,14}$/
export const NAME_MAX = 200

/** Tags que a automação da conversa liga/desliga sozinha (migration 036): o operador não as altera à mão. */
export const AUTO_MANAGED_TAG_NAMES: ReadonlySet<string> = new Set(['IA Conversando', 'Atendimento Humano'])

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** Telefone no mesmo formato do webhook do WhatsApp: só dígitos, DDI + DDD + número. */
export function parsePhone(raw: unknown): Parsed<string> {
  const phone = typeof raw === 'string' || typeof raw === 'number' ? normalizePhone(String(raw)) : ''
  if (!phone || !PHONE_RE.test(phone)) return { ok: false, error: 'Telefone inválido (use DDI + DDD + número)' }
  return { ok: true, value: phone }
}

/** CPF: aceita máscara, guarda só dígitos (como a importação). Vazio/null = limpar o campo. */
export function parseCpf(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, error: 'CPF inválido' }
  const digits = normalizeCpf(raw)
  if (digits === '') return { ok: true, value: null }
  if (!isValidCpf(digits)) return { ok: false, error: 'CPF inválido' }
  return { ok: true, value: digits }
}

export function parseEmail(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'E-mail inválido' }
  const email = raw.trim().toLowerCase()
  if (email === '') return { ok: true, value: null }
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: 'E-mail inválido' }
  return { ok: true, value: email }
}

export function parseName(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'Nome inválido' }
  const name = raw.trim()
  if (name.length > NAME_MAX) return { ok: false, error: `Nome muito longo (máx. ${NAME_MAX})` }
  return { ok: true, value: name || null }
}

/** Contato como a API devolve: o CPF NUNCA sai em claro (só mascarado), como na exibição do painel. */
export function serializeContact<T extends object>(input: T): Omit<T, 'cpf'> & { cpf_masked: string | null; has_cpf: boolean } {
  const { cpf, ...rest } = input as T & { cpf?: string | null }
  return { ...rest, cpf_masked: cpf ? maskCpf(cpf) : null, has_cpf: Boolean(cpf) }
}
