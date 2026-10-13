// Referências {{cred.NOME}} em textos de ferramenta/agente e checagem contra as credenciais da conta.
// Só trabalha com NOMES — nunca com valores (credencial é write-only).

const CRED_REF = /\{\{\s*cred\.([A-Za-z0-9_]+)\s*\}\}/g

/** Nomes (em MAIÚSCULAS, sem repetir, na ordem de aparição) referenciados nos textos. */
export function extractCredRefs(texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const m of text.matchAll(CRED_REF)) seen.add(m[1].toUpperCase())
  }
  return [...seen]
}

/** Referências que não têm uma credencial (kind=credential) cadastrada na conta. */
export function missingCredNames(
  refs: string[],
  secrets: Array<{ name: string; kind: 'variable' | 'credential' }>,
): string[] {
  const existing = new Set(secrets.filter((s) => s.kind === 'credential').map((s) => s.name.toUpperCase()))
  return refs.filter((r) => !existing.has(r.toUpperCase()))
}

/** Textos de uma ferramenta HTTP onde {{cred.NOME}} é aceito: URL, headers e body. */
export function toolHttpTexts(http: { url?: string; headers?: Record<string, string>; body?: string | null }): string[] {
  return [http.url ?? '', ...Object.values(http.headers ?? {}), http.body ?? '']
}
