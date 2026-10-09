// Mascaramento de dados pessoais para LOGS e EVENTOS (não para o que a IA/DDM recebem).

/** Para log de servidor: só os 2 últimos dígitos (`***12`). */
export function maskCpfForLog(cpf: string): string {
  return cpf.length >= 2 ? `***${cpf.slice(-2)}` : '***'
}

/** CPF no formato de evento: `***.***.***-12`. Aceita com ou sem pontuação; outro tamanho vira `***`. */
export function maskCpf(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length !== 11) return '***'
  return `***.***.***-${digits.slice(-2)}`
}

// 11 dígitos, com ou sem pontuação (não casa dentro de sequência maior de dígitos).
const CPF_IN_TEXT = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g

/** Troca qualquer CPF que apareça dentro de um texto. */
export function maskCpfInText(text: string): string {
  return text.replace(CPF_IN_TEXT, (m) => maskCpf(m))
}

const CPF_KEY = /cpf|doc(?:umento)?$|cnpj/i

/**
 * Cópia dos argumentos de uma tool com CPF mascarado: valores das chaves cpf/doc/documento/cnpj (string ou número) e
 * qualquer CPF dentro de textos. Não altera o objeto original (os args reais da chamada seguem intactos).
 */
export function maskPiiArgs<T>(value: T, key = ''): T {
  if (typeof value === 'string') {
    if (CPF_KEY.test(key) && value.replace(/\D/g, '').length >= 11) return maskCpf(value) as unknown as T
    return maskCpfInText(value) as unknown as T
  }
  if (typeof value === 'number') {
    if (CPF_KEY.test(key) && String(value).length >= 10) return maskCpf(String(value).padStart(11, '0')) as unknown as T
    return value
  }
  if (Array.isArray(value)) return value.map((v) => maskPiiArgs(v, key)) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskPiiArgs(v, k)])) as T
  }
  return value
}

/**
 * Telefone só com os 4 últimos dígitos (`+5511999998888` → `****8888`); aceita qualquer formato de entrada. Vazio vira null
 * (payload de writeLog). `logger.maskPhone` é a reexportação desta função — um mascarador só.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length <= 4) return '****'
  return `****${digits.slice(-4)}`
}

/** Para `console.*`: igual a `maskPhone`, mas sempre string (nunca `null` na interpolação). */
export function maskPhoneForLog(phone: string | null | undefined): string {
  return maskPhone(phone) ?? '****'
}

/** Para log de servidor: e-mail sem o usuário (`m***@dominio`). Sem `@` vira `***`. */
export function maskEmailForLog(email: string | null | undefined): string {
  const value = email ?? ''
  const at = value.lastIndexOf('@')
  return at > 0 ? `${value[0]}***${value.slice(at)}` : '***'
}

/**
 * Para log de servidor: trecho de texto livre (corpo de resposta de parceiro, mensagem) com CPF mascarado e cortado em `max`
 * caracteres. Nunca registre o corpo inteiro: ele pode trazer nome e telefone que nenhuma regex pega.
 */
export function maskTextForLog(text: string | null | undefined, max = 200): string {
  const masked = maskCpfInText(text ?? '')
  return masked.length > max ? `${masked.slice(0, max)}…` : masked
}

/**
 * Erro do banco/PostgREST para log: só `code` e `message`. O `details` de uma violação de unicidade traz o VALOR da chave
 * (`Key (phone)=(5511…) already exists`) e o `hint` pode repetir trechos da linha; por isso nunca vão para o console.
 */
export function safeDbError(error: unknown): { code?: string; message: string } {
  const e = (error ?? {}) as { code?: unknown; message?: unknown }
  const message = typeof e.message === 'string' ? e.message : String(error)
  return { ...(typeof e.code === 'string' ? { code: e.code } : {}), message: maskTextForLog(message, 300) }
}

/** URL para log: sem query string, fragmento nem credenciais (`https://host/caminho`) — token em `?key=` não vai para o console. */
export function maskUrlForLog(url: string | null | undefined): string {
  try {
    const u = new URL(String(url))
    return `${u.origin}${u.pathname}`
  } catch {
    return '***'
  }
}
