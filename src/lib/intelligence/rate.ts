// Limite por usuário das chamadas de ferramenta do Intelligence. Um único
// balde por usuário, compartilhado entre POST /api/intelligence/tools/[name]
// e as chamadas feitas pelo chat — o chat não ganha orçamento extra.

import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";

export const INTELLIGENCE_TOOL_RATE = { limit: 60, windowMs: 60_000 } as const;

export function checkIntelligenceToolRate(userId: string): RateLimitResult {
  return checkRateLimit(`intelligence:${userId}`, INTELLIGENCE_TOOL_RATE);
}
