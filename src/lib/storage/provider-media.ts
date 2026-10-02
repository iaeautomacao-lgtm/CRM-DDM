import { supabaseAdmin } from '@/lib/flows/admin-client';
import { chatMediaPath } from './chat-media';
export async function resolveProviderMedia(url: string, accountId: string): Promise<string> {
  const path = chatMediaPath(url);
  if (!path) return url;
  if (!path.startsWith(`account-${accountId}/`) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Anexo não autorizado');
  const { data, error } = await supabaseAdmin().storage.from('chat-media').createSignedUrl(path, 600);
  if (error || !data?.signedUrl) throw new Error('Não foi possível preparar o anexo');
  return data.signedUrl;
}
