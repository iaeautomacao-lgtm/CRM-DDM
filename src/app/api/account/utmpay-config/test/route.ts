import { NextResponse } from "next/server";

import { guardPermission } from "@/lib/auth/route-guard";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from "@/lib/rate-limit";
import { safeFetch } from "@/lib/security/ssrf-guard";
import { loadUtmpayConfig, resetUtmpayConfigCache } from "@/lib/utmpay/config";

export const dynamic = "force-dynamic";

// POST /api/account/utmpay-config/test  → { ok: boolean, message: string }   ("Testar conexão" da tela; permissão settings.account)
// Chama GET {base_url}/health do UTMpay com a base_url GRAVADA (nunca uma enviada no corpo). Mensagens genéricas: sem URL, sem chave, sem detalhe do erro.
export async function POST() {
  const auth = await guardPermission("settings.account");
  if (!auth.ok) return auth.response;
  const { accountId, userId } = auth.ctx;

  const limit = await checkRateLimit(`utmpay-test:${userId}`, RATE_LIMITS.utmpayTest);
  if (!limit.success) return rateLimitResponse(limit);

  resetUtmpayConfigCache(accountId);
  const config = await loadUtmpayConfig(supabaseAdmin(), accountId);
  if (!config) return NextResponse.json({ ok: false, message: "UTMpay ainda não configurado." });

  try {
    const res = await safeFetch(`${config.baseUrl}/health`, { method: "GET" }, { timeoutMs: 8_000, maxBytes: 64 * 1024, failOnCrossOriginRedirect: true });
    if (!res.ok) return NextResponse.json({ ok: false, message: `O UTMpay respondeu com erro (HTTP ${res.status}).` });
  } catch {
    return NextResponse.json({ ok: false, message: "Não foi possível alcançar o UTMpay." });
  }
  const missing = [!config.apiKey && "chave da API", !config.webhookSecret && "segredo do webhook"].filter(Boolean);
  if (missing.length > 0) return NextResponse.json({ ok: false, message: `O UTMpay respondeu, mas falta cadastrar: ${missing.join(" e ")}.` });
  return NextResponse.json({ ok: true, message: "Conexão com o UTMpay funcionando." });
}
