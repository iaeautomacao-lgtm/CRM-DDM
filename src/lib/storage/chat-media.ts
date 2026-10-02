// Referências de mídia do chat (bucket privado `chat-media`, migration 121).
//
// O banco guarda uma referência estável `/api/chat-media/<caminho>` em vez
// de uma URL pública permanente do Storage. O navegador acessa essa rota,
// que valida a sessão/conta e redireciona para uma URL assinada curta.
// Para provedores (Meta/WAHA) ver `resolveProviderMedia` em provider-media.ts.

/**
 * Extrai o caminho do objeto no bucket (`account-<uuid>/...`) a partir de
 * qualquer formato de referência conhecido:
 * - caminho cru `account-...`;
 * - referência interna `/api/chat-media/...`;
 * - URL antiga do Supabase Storage (`/object/public/` ou `/object/sign/`)
 *   gravada antes do bucket ficar privado — só se for do NOSSO projeto.
 *
 * Retorna null para URLs externas (ex.: mídia hospedada por terceiros),
 * que devem ser usadas como estão.
 */
export function chatMediaPath(url: string): string | null {
  if (url.startsWith('account-')) return url;
  if (url.startsWith('/api/chat-media/')) {
    try { return decodeURIComponent(url.slice('/api/chat-media/'.length).split('?')[0]); }
    catch { return null; }
  }
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://invalid.local').origin) return null;
    const match = parsed.pathname.match(/^\/storage\/v1\/object\/(?:public|sign)\/chat-media\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

/** Monta a referência autenticada usada pelo navegador para um caminho do bucket. */
export function chatMediaReference(path: string): string {
  // Codifica segmento a segmento para preservar as `/` do caminho.
  return `/api/chat-media/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Normaliza URLs antigas do bucket para a referência autenticada; URLs externas passam intactas. */
export function privateChatMediaUrl(url: string): string {
  const path = chatMediaPath(url);
  return path ? chatMediaReference(path) : url;
}
