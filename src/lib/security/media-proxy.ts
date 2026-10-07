/**
 * Helpers do proxy de mídia (WAHA/Meta): caminho de arquivo restrito e
 * cabeçalhos de resposta seguros. O Content-Type do upstream (controlado
 * pelo remetente da mensagem) nunca é repassado cru: um .html com
 * `text/html` executaria JS na origem do app.
 */

const MAX_FILE_PATH_LENGTH = 300
// Controle, separadores de caminho, query/fragment, % e barra invertida.
function hasForbiddenChar(seg: string): boolean {
  for (const ch of seg) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f || ch === '\\' || ch === '?' || ch === '#' || ch === '%') return true
  }
  return false
}

/**
 * Valida o parâmetro `file` do proxy WAHA (`<sessão>/<arquivo>`) e devolve
 * o caminho já codificado por segmento, pronto para `/api/files/<caminho>`.
 * Rejeita `.`/`..`, segmentos vazios (barra inicial/dupla), `?`, `#`, `%`,
 * `\` e caracteres de controle — nada escapa do prefixo `/api/files/`.
 * Retorna null se inválido.
 */
export function sanitizeWahaFilePath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_FILE_PATH_LENGTH) return null
  const segments = raw.split('/')
  if (segments.length > 4) return null
  for (const seg of segments) {
    if (!seg || seg.trim() === '' || seg === '.' || seg === '..' || hasForbiddenChar(seg)) {
      return null
    }
  }
  return segments.map(encodeURIComponent).join('/')
}

const INLINE_SAFE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/webm',
  'audio/amr',
  'video/mp4',
  'video/webm',
  'video/3gpp',
  'video/quicktime',
  'application/pdf',
])

/** Content-Type permitido para exibição inline, ou null (→ download). */
export function safeInlineContentType(raw: string | null | undefined): string | null {
  const base = (raw ?? '').split(';')[0].trim().toLowerCase()
  return INLINE_SAFE_TYPES.has(base) ? base : null
}

/** Cabeçalhos de uma resposta de mídia autenticada. */
export function mediaResponseHeaders(
  upstreamContentType: string | null | undefined,
): Record<string, string> {
  const safe = safeInlineContentType(upstreamContentType)
  return {
    'Content-Type': safe ?? 'application/octet-stream',
    'Content-Disposition': safe ? 'inline' : 'attachment',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    // Resposta autenticada: só cache do navegador do usuário.
    'Cache-Control': 'private, max-age=3600',
  }
}
