// Caminho rápido do webhook Meta (POST /api/whatsapp/webhook).
// Cache e helpers puros — sem worker/setInterval (compatível com Passenger):
// o cache é só um Map por processo com expiração lazy.

export const APP_SECRET_CACHE_TTL_MS = 60_000

interface CacheEntry {
  /** app_secret como gravado no banco (cifrado ou texto puro legado). */
  stored: string
  expiresAt: number
}

const appSecretCache = new Map<string, CacheEntry>()

/** Valor gravado do app_secret em cache para o canal, ou undefined. */
export function getCachedStoredAppSecret(
  phoneNumberId: string,
  now: number = Date.now(),
): string | undefined {
  const hit = appSecretCache.get(phoneNumberId)
  if (!hit) return undefined
  if (hit.expiresAt <= now) {
    appSecretCache.delete(phoneNumberId)
    return undefined
  }
  return hit.stored
}

/** Só guarda segredo existente: canal sem app_secret/erro de leitura não entra. */
export function cacheStoredAppSecret(
  phoneNumberId: string,
  stored: string,
  now: number = Date.now(),
): void {
  appSecretCache.set(phoneNumberId, {
    stored,
    expiresAt: now + APP_SECRET_CACHE_TTL_MS,
  })
}

export function invalidateAppSecret(phoneNumberId: string): void {
  appSecretCache.delete(phoneNumberId)
}

export function clearAppSecretCache(): void {
  appSecretCache.clear()
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
