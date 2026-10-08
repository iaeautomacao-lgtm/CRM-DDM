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
