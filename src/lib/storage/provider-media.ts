import { supabaseAdmin } from '@/lib/flows/admin-client';
import { chatMediaPath } from './chat-media';
import { assertPublicUrl, SsrfBlockedError } from '@/lib/security/ssrf-guard';

/**
 * Converte uma referência de mídia do chat em URL que o provedor
 * (Meta/WAHA) consegue baixar no momento do envio.
 *
 * Com o bucket `chat-media` privado, Meta/WAHA não têm sessão para usar
 * `/api/chat-media/...`; então geramos uma URL assinada de 10 minutos,
 * suficiente para o provedor buscar o arquivo logo após o POST.
 *
 * Segurança: o caminho precisa estar dentro da pasta da própria conta
 * (`account-<accountId>/`) e não pode ter segmentos `.`/`..`. Sem isso,
 * um usuário poderia enviar `media_url` apontando para anexo de outra conta
 * e o service role assinaria a URL.
 *
 * URLs externas (não pertencentes ao bucket) são devolvidas sem alteração, mas só
 * se apontarem para host público (assertPublicUrl): o provedor (WAHA/Meta) é quem
 * baixa, e não podemos deixar o tenant mandá-lo a rede interna (PRD 14, SW-2).
 */
/** media_url externa que não aponta para host público; a rota responde 400. */
export class MediaUrlNotAllowedError extends Error {
  constructor() {
    super('media_url não permitida');
    this.name = 'MediaUrlNotAllowedError';
  }
}

// Cache curto (AUDIT-DISPARADOR): uma campanha de imagem manda o MESMO anexo para todos os itens. Sem cache, cada envio fazia 1 chamada
// ao Storage (assinar a URL) ou 1 verificação SSRF com DNS: a 80 envios/s seriam 80 chamadas/s só para isso. A URL assinada vale 10 min;
// reaproveitada por até 5 min, o provedor ainda tem >= 5 min para baixar. O cache guarda a PROMISE (50 envios simultâneos no início do
// tick compartilham uma única chamada) e nunca guarda falha. A checagem de conta e de caminho roda SEMPRE, antes do cache.
const SIGNED_URL_SECONDS = 600
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 200
interface CacheEntry { value: Promise<string>; expiresAt: number }
const mediaCache = new Map<string, CacheEntry>()

function cached(key: string, load: () => Promise<string>, now: number): Promise<string> {
  const hit = mediaCache.get(key)
  if (hit && hit.expiresAt > now) return hit.value
  if (mediaCache.size >= CACHE_MAX) {
    for (const [k, v] of mediaCache) if (v.expiresAt <= now) mediaCache.delete(k)
    if (mediaCache.size >= CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value as string)
  }
  const value = load()
  mediaCache.set(key, { value, expiresAt: now + CACHE_TTL_MS })
  // Falha nunca fica em cache: o próximo envio tenta de novo.
  value.catch(() => { if (mediaCache.get(key)?.value === value) mediaCache.delete(key) })
  return value
}

/** Só para testes. */
export function resetProviderMediaCache(): void {
  mediaCache.clear()
}

export async function resolveProviderMedia(url: string, accountId: string, now: number = Date.now()): Promise<string> {
  const path = chatMediaPath(url);
  if (!path) {
    return cached(`ext:${url}`, async () => {
      try {
        await assertPublicUrl(url);
      } catch (err) {
        if (err instanceof SsrfBlockedError) throw new MediaUrlNotAllowedError();
        throw err;
      }
      return url;
    }, now);
  }
  if (!path.startsWith(`account-${accountId}/`) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Anexo não autorizado');
  return cached(`sig:${path}`, async () => {
    const { data, error } = await supabaseAdmin().storage.from('chat-media').createSignedUrl(path, SIGNED_URL_SECONDS);
    if (error || !data?.signedUrl) throw new Error('Não foi possível preparar o anexo');
    return data.signedUrl;
  }, now);
}
