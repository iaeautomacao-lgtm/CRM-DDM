import { supabaseAdmin } from '@/lib/flows/admin-client';
import { chatMediaPath } from './chat-media';

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
 * URLs externas (não pertencentes ao bucket) são devolvidas sem alteração.
 */
export async function resolveProviderMedia(url: string, accountId: string): Promise<string> {
  const path = chatMediaPath(url);
  if (!path) return url;
  if (!path.startsWith(`account-${accountId}/`) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Anexo não autorizado');
  const { data, error } = await supabaseAdmin().storage.from('chat-media').createSignedUrl(path, 600);
  if (error || !data?.signedUrl) throw new Error('Não foi possível preparar o anexo');
  return data.signedUrl;
}
