import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  matchesLegacyWahaSecret,
  matchesWahaChannelSecret,
  wahaChannelWebhookSecret,
  wahaWebhookFor,
  wahaWebhookUrl,
} from './waha-webhook-auth';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('segredo e URL do webhook WAHA por canal', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('deriva segredos distintos por canal sem expor o segredo global', () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'global-secret');
    const a = wahaChannelWebhookSecret(A);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('global-secret');
    expect(wahaChannelWebhookSecret(B)).not.toBe(a);
    expect(wahaChannelWebhookSecret(A.toUpperCase())).toBe(a);
  });

  it('aceita só o segredo do próprio canal', () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'global-secret');
    expect(matchesWahaChannelSecret(A, wahaChannelWebhookSecret(A))).toBe(true);
    expect(matchesWahaChannelSecret(B, wahaChannelWebhookSecret(A))).toBe(false);
    expect(matchesWahaChannelSecret(A, 'global-secret')).toBe(false);
    expect(matchesWahaChannelSecret(A, null)).toBe(false);
    expect(matchesWahaChannelSecret('nao-uuid', 'x')).toBe(false);
  });

  it('fail-closed sem WAHA_WEBHOOK_SECRET', () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', '');
    expect(() => wahaChannelWebhookSecret(A)).toThrow();
    expect(matchesWahaChannelSecret(A, 'qualquer')).toBe(false);
  });

  it('monta a URL a partir de NEXT_PUBLIC_APP_URL, com o id do canal', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com/qualquer/caminho');
    expect(wahaWebhookUrl(A)).toBe(`https://crm.example.com/api/whatsapp/webhook/waha?channel=${A}`);
  });

  it('usa NEXT_PUBLIC_SITE_URL como alternativa e falha sem nenhuma URL configurada', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://site.example.com');
    expect(wahaWebhookUrl(A)).toBe(`https://site.example.com/api/whatsapp/webhook/waha?channel=${A}`);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(() => wahaWebhookUrl(A)).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('wahaWebhookFor junta URL e segredo do canal', () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'global-secret');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com');
    expect(wahaWebhookFor(A)).toEqual({
      url: `https://crm.example.com/api/whatsapp/webhook/waha?channel=${A}`,
      secret: wahaChannelWebhookSecret(A),
    });
  });

  it('segredo global legado só vale com a flag de transição', () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'global-secret');
    expect(matchesLegacyWahaSecret('global-secret')).toBe(false);
    vi.stubEnv('WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET', 'true');
    expect(matchesLegacyWahaSecret('global-secret')).toBe(true);
    expect(matchesLegacyWahaSecret('outro')).toBe(false);
  });
});
