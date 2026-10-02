// Stable browser references never expose a permanent public storage URL.
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
export function chatMediaReference(path: string): string {
  return `/api/chat-media/${path.split('/').map(encodeURIComponent).join('/')}`;
}
export function privateChatMediaUrl(url: string): string {
  const path = chatMediaPath(url);
  return path ? chatMediaReference(path) : url;
}
