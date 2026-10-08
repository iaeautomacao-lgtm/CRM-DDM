// Liga o inbox de mensagens (message-inbox.ts) ao processamento real (inbound-message.ts).
// Separado para o módulo da fila ficar puro/testável e o cron importar só o que precisa.
import { decrypt } from '@/lib/whatsapp/encryption'
import { writeLog } from '@/lib/logger'
import { processMessage, type WhatsAppMessage } from '@/lib/whatsapp/inbound-message'
import type { WebhookContact } from '@/lib/whatsapp/webhook-contacts'
import {
  drainMessageInbox,
  type DrainMessageOptions,
  type DrainMessageSummary,
  type InboxDb,
  type InboxRow,
  type RowOutcome,
} from '@/lib/whatsapp/message-inbox'

/** Colunas lidas de whatsapp_config (todas existem desde as migrations 001/013/017). */
export const INBOX_CHANNEL_COLUMNS = 'id, account_id, user_id, access_token'

type ChannelRow = { id: string; account_id: string; user_id: string; access_token: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = InboxDb & { from(table: string): any }

/** Processa uma linha do inbox: relê o canal (o token nunca fica no inbox) e roda o processamento de sempre. */
export function createInboxProcessor(db: Db): (row: InboxRow) => Promise<RowOutcome> {
  const channels = new Map<string, Promise<ChannelRow>>()
  const load = (channelId: string): Promise<ChannelRow> => {
    let p = channels.get(channelId)
    if (!p) {
      p = (async () => {
        const { data, error } = await db.from('whatsapp_config').select(INBOX_CHANNEL_COLUMNS).eq('id', channelId).limit(1)
        if (error) throw new Error(`Falha ao ler o canal ${channelId}: ${error.message}`)
        const row = (data as ChannelRow[] | null)?.[0]
        if (!row) throw new Error(`Canal ${channelId} não encontrado (apagado?)`)
        return row
      })()
      channels.set(channelId, p)
      // Não guarda falha: a próxima linha do lote tenta de novo.
      p.catch(() => channels.delete(channelId))
    }
    return p
  }

  return async (row) => {
    const channel = await load(row.channel_id)
    // Defesa em profundidade: o canal que validou o HMAC tem de ser da conta gravada no evento.
    if (channel.account_id !== row.account_id) throw new Error('Conta do canal diverge do evento gravado')
    const { message, contact } = row.payload as {
      message: WhatsAppMessage
      contact: WebhookContact | null
    }
    return processMessage(message, contact, channel.account_id, channel.user_id, decrypt(channel.access_token), channel.id)
  }
}

/** Drena o inbox com o processamento real; esgotar tentativas vira log de erro (alerta). Nunca lança. */
export function drainMessageInboxLive(db: Db, options: Omit<DrainMessageOptions, 'process'> = {}): Promise<DrainMessageSummary> {
  return drainMessageInbox(db, {
    ...options,
    process: createInboxProcessor(db),
    onDead: (row, error) => {
      console.error('[message-inbox] mensagem marcada como dead:', row.message_id, error)
      void writeLog({
        account_id: row.account_id,
        level: 'error',
        source: 'webhook_meta',
        event: 'message_inbox_dead',
        message: `Mensagem da Meta não pôde ser processada após ${row.attempts} tentativas (inbox: dead)`,
        payload: { inbox_id: row.id, message_id: row.message_id, channel_id: row.channel_id, erro: error },
      })
    },
  })
}
