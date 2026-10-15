import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { rateLimited } from '@/lib/api/v1/respond';

/** 30 req/min por chave nas rotas de ESCRITA de conversa (abrir, encerrar, transferir), além dos 120/min gerais. */
export async function enforceConversationControlLimit(ctx: { keyId: string; accountId: string }): Promise<void> {
  const result = await checkRateLimit(`apikey-conv-control:${ctx.keyId}`, RATE_LIMITS.apiV1ConversationControl);
  if (!result.success) throw rateLimited(result, { accountId: ctx.accountId, keyId: ctx.keyId });
}
