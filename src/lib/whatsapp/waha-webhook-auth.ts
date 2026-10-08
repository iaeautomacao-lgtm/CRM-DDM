import { createHmac } from 'node:crypto';
import { matchesOperationalSecret } from '@/lib/auth/operational-secret';

/**
 * Autenticação do webhook WAHA por canal (whatsapp_config).
 *
 * O WAHA_WEBHOOK_SECRET global nunca sai do servidor: cada canal recebe um
 * segredo derivado, HMAC-SHA256(WAHA_WEBHOOK_SECRET, id do canal), que é o
 * único valor gravado no customHeaders do servidor WAHA daquele tenant.
 * O id do canal vai na query da URL do webhook (não é segredo) e permite
 * validar o header sem consultar o banco. Quem conhece o segredo de um canal
 * só consegue postar eventos para aquele canal (e o webhook ainda confere
 * que a `session` do corpo é a sessão do canal).
 */

export const WAHA_WEBHOOK_PATH = '/api/whatsapp/webhook/waha';
export const WAHA_WEBHOOK_CHANNEL_PARAM = 'channel';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWahaChannelId(value: string | null | undefined): value is string {
  return !!value && UUID_RE.test(value);
}

function masterSecret(): string {
  const secret = process.env.WAHA_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('WAHA_WEBHOOK_SECRET must be configured before starting a webhook session');
  }
  return secret;
}

/** Segredo do header x-webhook-secret para um canal WAHA. */
export function wahaChannelWebhookSecret(configId: string): string {
  if (!isWahaChannelId(configId)) throw new Error('Invalid WAHA channel id');
  return createHmac('sha256', masterSecret())
    .update(`waha-webhook:v1:${configId.toLowerCase()}`)
    .digest('hex');
}

/**
 * URL pública do webhook, sempre a partir de env confiável — nunca de
 * Host/X-Forwarded-Host da requisição (que o chamador controla).
 */
export function wahaWebhookUrl(configId: string): string {
  const base = [process.env.NEXT_PUBLIC_APP_URL, process.env.NEXT_PUBLIC_SITE_URL]
    .map((value) => value?.trim())
    .find((value) => !!value);
  if (!base) {
    throw new Error('NEXT_PUBLIC_APP_URL deve ser configurada para registrar o webhook WAHA');
  }
  if (!isWahaChannelId(configId)) throw new Error('Invalid WAHA channel id');
  const url = new URL(WAHA_WEBHOOK_PATH, new URL(base).origin);
  url.searchParams.set(WAHA_WEBHOOK_CHANNEL_PARAM, configId.toLowerCase());
  return url.toString();
}

/** Configuração de webhook (URL + segredo do canal) para startWahaSession. */
export function wahaWebhookFor(configId: string): { url: string; secret: string } {
  return { url: wahaWebhookUrl(configId), secret: wahaChannelWebhookSecret(configId) };
}

export function matchesWahaChannelSecret(configId: string, supplied: string | null): boolean {
  if (!isWahaChannelId(configId) || !process.env.WAHA_WEBHOOK_SECRET) return false;
  return matchesOperationalSecret(wahaChannelWebhookSecret(configId), supplied);
}

/**
 * Transição: sessões criadas antes do segredo por canal enviam o segredo
 * global e não têm `?channel=`. Só aceito com WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET=true
 * (desligar depois de reiniciar todas as sessões pelo CRM).
 */
export function legacyWahaSecretAllowed(): boolean {
  return process.env.WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET === 'true';
}

export function matchesLegacyWahaSecret(supplied: string | null): boolean {
  return legacyWahaSecretAllowed()
    && matchesOperationalSecret(process.env.WAHA_WEBHOOK_SECRET, supplied);
}
