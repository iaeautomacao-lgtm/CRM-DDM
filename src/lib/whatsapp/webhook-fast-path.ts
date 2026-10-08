// Caminho rápido do webhook Meta (POST /api/whatsapp/webhook).
// Cache e helpers puros — sem worker/setInterval (compatível com Passenger):
// o cache é só um Map por processo com expiração lazy.

export const APP_SECRET_CACHE_TTL_MS = 60_000

/** Canal Meta resolvido (whatsapp_config) usado para validar e escopar o POST. */
export interface ChannelRow {
  id: string
  account_id: string
  /** app_secret como gravado no banco (cifrado ou texto puro legado), ou null. */
  app_secret: string | null
}

interface CacheEntry {
  row: ChannelRow
  expiresAt: number
}

const channelCache = new Map<string, CacheEntry>()

/** Chave de cache: 'pn:<phone_number_id>' ou 'waba:<waba_id>'. */
export function getCachedChannel(
  key: string,
  now: number = Date.now(),
): ChannelRow | undefined {
  const hit = channelCache.get(key)
  if (!hit) return undefined
  if (hit.expiresAt <= now) {
    channelCache.delete(key)
    return undefined
  }
  return hit.row
}

/** Só guarda canal existente: canal desconhecido/erro de leitura não entra. */
export function cacheChannel(
  key: string,
  row: ChannelRow,
  now: number = Date.now(),
): void {
  channelCache.set(key, { row, expiresAt: now + APP_SECRET_CACHE_TTL_MS })
}

export function invalidateChannel(key: string): void {
  channelCache.delete(key)
}

export function clearAppSecretCache(): void {
  channelCache.clear()
  rejectionGate.clear()
}

// Assinatura inválida é tráfego SEM autenticação: cada POST falho não pode custar 1 leitura no banco +
// 1 INSERT em system_logs (W4). Cache negativo curto: o trabalho caro (reler o canal, gravar log) acontece
// no máximo 1× por janela e por chave; os demais POSTs inválidos são rejeitados só com HMAC em memória.
export const REJECTION_GATE_WINDOW_MS = 30_000
const rejectionGate = new Map<string, number>()

/** true na PRIMEIRA ocorrência da chave dentro da janela (faça o trabalho caro); false depois. */
export function allowExpensiveRejection(
  key: string,
  now: number = Date.now(),
  windowMs: number = REJECTION_GATE_WINDOW_MS,
): boolean {
  const last = rejectionGate.get(key)
  if (last !== undefined && now - last < windowMs) return false
  rejectionGate.set(key, now)
  if (rejectionGate.size > 1000) {
    for (const [k, t] of rejectionGate) if (now - t >= windowMs) rejectionGate.delete(k)
  }
  return true
}

/**
 * 'sent' não agrega: o envio já grava a mensagem como enviada e o RPC do
 * disparador devolve false logo no início para ele. Só delivered/read/failed
 * mudam algo (messages, fila do disparador, "Testar canal").
 */
const STATUSES_THAT_MATTER = new Set(['delivered', 'read', 'failed'])

export function shouldProcessStatus(status: string): boolean {
  return STATUSES_THAT_MATTER.has(status)
}

/**
 * Processa cada status isoladamente: o erro de um não descarta os demais do
 * mesmo POST (a Meta não reenvia, já recebeu 200). Retorna quantos falharam.
 */
export async function processStatusesIndependently<T extends { status: string }>(
  statuses: readonly T[],
  handler: (status: T) => Promise<void>,
  onError: (status: T, error: unknown) => void,
): Promise<number> {
  let failures = 0
  for (const status of statuses) {
    if (!shouldProcessStatus(status.status)) continue
    try {
      await handler(status)
    } catch (error) {
      failures++
      try {
        onError(status, error)
      } catch {
        // log nunca pode derrubar o loop
      }
    }
  }
  return failures
}

/** Chave de canal de uma change: template → WABA da entry; demais → phone_number_id. */
export function channelKeyForChange(
  entry: { id?: string },
  change: { field?: string; value?: { metadata?: { phone_number_id?: string } } },
  isTemplateField: boolean,
): string | null {
  if (isTemplateField) return entry?.id ? `waba:${entry.id}` : null
  const pn = change?.value?.metadata?.phone_number_id
  return pn ? `pn:${pn}` : null
}
