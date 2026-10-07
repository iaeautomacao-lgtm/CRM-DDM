import { describe, it, expect } from 'vitest'
import { mediaResponseHeaders, safeInlineContentType, sanitizeWahaFilePath } from './media-proxy'

describe('sanitizeWahaFilePath', () => {
  it('aceita sessão/arquivo comuns', () => {
    expect(sanitizeWahaFilePath('default/3EB0ABC123.jpeg')).toBe('default/3EB0ABC123.jpeg')
    expect(sanitizeWahaFilePath('sessao_1/false_5511@c.us_ABC.ogg')).toBe('sessao_1/false_5511%40c.us_ABC.ogg')
  })

  it('codifica espaços em vez de rejeitar', () => {
    expect(sanitizeWahaFilePath('default/meu arquivo.pdf')).toBe('default/meu%20arquivo.pdf')
  })

  it.each([
    '../sessions',
    'default/../../sessions',
    '..',
    '.',
    './x',
    '/default/x',
    'default//x',
    'default/x?y=1',
    'default/x#frag',
    'default/%2e%2e/x',
    'default\\..\\x',
    'a/b/c/d/e',
    '',
    'default/x\u0000.jpg',
  ])('rejeita %j', (file) => {
    expect(sanitizeWahaFilePath(file)).toBeNull()
  })

  it('rejeita nulo/undefined e caminhos enormes', () => {
    expect(sanitizeWahaFilePath(null)).toBeNull()
    expect(sanitizeWahaFilePath(undefined)).toBeNull()
    expect(sanitizeWahaFilePath('a/' + 'b'.repeat(400))).toBeNull()
  })
})

describe('mediaResponseHeaders', () => {
  it('mantém tipos seguros inline e sempre com nosniff', () => {
    const h = mediaResponseHeaders('image/png')
    expect(h['Content-Type']).toBe('image/png')
    expect(h['Content-Disposition']).toBe('inline')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Cache-Control']).toMatch(/^private/)
  })

  it('remove parâmetros do Content-Type', () => {
    expect(mediaResponseHeaders('audio/ogg; codecs=opus')['Content-Type']).toBe('audio/ogg')
  })

  it.each(['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml', 'application/javascript', null, undefined, ''])(
    'força download para %j',
    (ct) => {
      const h = mediaResponseHeaders(ct)
      expect(h['Content-Type']).toBe('application/octet-stream')
      expect(h['Content-Disposition']).toBe('attachment')
      expect(h['X-Content-Type-Options']).toBe('nosniff')
      expect(h['Content-Security-Policy']).toContain('sandbox')
    },
  )

  it('safeInlineContentType é case-insensitive', () => {
    expect(safeInlineContentType('IMAGE/JPEG')).toBe('image/jpeg')
    expect(safeInlineContentType('text/html')).toBeNull()
  })
})
