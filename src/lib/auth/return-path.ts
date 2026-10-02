/**
 * Valida o parâmetro `?next=` usado para voltar à página original após o
 * login. Evita open redirect: só aceita caminhos relativos do próprio CRM.
 *
 * Rejeita (e usa `fallback`):
 * - qualquer coisa que não comece com `/`, ou que comece com `//`
 *   (protocol-relative → outro domínio);
 * - barras invertidas e caracteres de controle, inclusive depois de
 *   decodificar (`%2F%2F`, `%5C`), que alguns navegadores normalizam para `/`;
 * - rotas de API e de autenticação, para não criar loops de login.
 *
 * O retorno é só conveniência de navegação: a página de destino continua
 * aplicando a própria autorização.
 */
export function safeReturnPath(
  raw: string | null | undefined,
  fallback = '/dashboard'
): string {
  if (
    !raw?.startsWith('/') ||
    raw.startsWith('//') ||
    /[\\\u0000-\u001f]/.test(raw)
  )
    return fallback;
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith('//') || decoded.includes('\\')) return fallback;
    // Resolve contra uma origem fictícia: se o resultado sair dela, o valor
    // tentava apontar para outro host.
    const url = new URL(raw, 'https://crm.invalid');
    if (url.origin !== 'https://crm.invalid') return fallback;
    if (
      /^\/(?:api|auth|login|signup|forgot-password)(?:\/|$)/.test(url.pathname)
    )
      return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    // decodeURIComponent lança com sequências % inválidas.
    return fallback;
  }
}
