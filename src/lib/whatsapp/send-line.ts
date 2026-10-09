// Linha escolhida no envio (PRD 23, item 7): `channel_id` em POST /api/whatsapp/send.
//
// A linha (whatsapp_config.id) tem de ser uma que o OPERADOR enxerga: a consulta usa a sessão dele, então a RLS de whatsapp_config
// (migrations 103/140) já limita o agente às linhas da(s) equipe(s) dele + as sem equipe; owner/admin/supervisor/viewer veem as da conta.
// Linha de outra conta, de equipe alheia, inexistente ou desabilitada nunca chega ao provedor. Meta × WAHA continuam separados: aqui só se
// DESCOBRE o provedor da linha; o envio segue os ramos de sempre (`config.provider`).
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SendLine {
  id: string
  provider: 'meta' | 'waha'
  waha_session: string | null
  habilitado: boolean
}

export type ResolveSendLine =
  | { ok: true; line: SendLine }
  | { ok: false; status: 400 | 404 | 409; code: 'invalid_channel_id' | 'line_not_found' | 'line_disabled'; error: string }

export async function resolveSendLine(
  supabase: SupabaseClient,
  accountId: string,
  channelId: unknown,
): Promise<ResolveSendLine> {
  if (typeof channelId !== 'string' || !UUID.test(channelId)) {
    return { ok: false, status: 400, code: 'invalid_channel_id', error: 'channel_id inválido' }
  }
  const { data, error } = await fetchChannelConfigs<{ id: string; provider: string | null; waha_session: string | null; habilitado: boolean | null }>(
    supabase,
    accountId,
    (q) => q.eq('id', channelId).eq('account_id', accountId),
    'id, provider, waha_session, habilitado',
  )
  const row = data?.[0]
  // Mesma resposta para "não existe" e "sem acesso": não revela linhas de outras equipes/contas.
  if (error || !row) return { ok: false, status: 404, code: 'line_not_found', error: 'Linha não encontrada ou sem acesso' }
  if (row.habilitado === false) return { ok: false, status: 409, code: 'line_disabled', error: 'Esta linha está desabilitada' }
  return {
    ok: true,
    line: { id: row.id, provider: row.provider === 'waha' ? 'waha' : 'meta', waha_session: row.waha_session ?? null, habilitado: true },
  }
}

/** Conversa existente só pode ser respondida pela linha dela: devolve a mensagem de erro se `line` não é a da conversa. */
export function lineMismatch(
  conversation: { config_id?: string | null; waha_session?: string | null },
  line: SendLine,
): string | null {
  if (conversation.config_id) {
    return conversation.config_id === line.id ? null : 'Esta conversa pertence a outra linha; abra uma nova conversa para usar a linha escolhida'
  }
  if (conversation.waha_session) {
    return conversation.waha_session === line.waha_session ? null : 'Esta conversa pertence a outra linha; abra uma nova conversa para usar a linha escolhida'
  }
  return null // conversa antiga sem vínculo de linha: não há conflito a apontar
}
