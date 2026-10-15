import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { rateLimited } from '@/lib/api/v1/respond';

/** 60 req/min por chave nos catálogos (tabulações, atendentes, equipes), além dos 120/min gerais. */
export async function enforceCatalogRateLimit(ctx: { keyId: string; accountId: string }): Promise<void> {
  const result = await checkRateLimit(`apikey-catalog:${ctx.keyId}`, RATE_LIMITS.apiV1Catalog);
  if (!result.success) throw rateLimited(result, { accountId: ctx.accountId, keyId: ctx.keyId });
}
