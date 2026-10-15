import { NextResponse } from "next/server";

import { guardPermission } from "@/lib/auth/route-guard";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from "@/lib/rate-limit";
import { buildChecklist } from "@/lib/utmpay/checklist";
import { connectUtmpay, connectionFromResult } from "@/lib/utmpay/connect";
import { utmpayEventsUrl, viewUtmpayConfig } from "@/lib/utmpay/config-api";
import { loadStoredCredentials } from "@/lib/utmpay/stored-credentials";

export const dynamic = "force-dynamic";

// POST /api/account/utmpay-config/connect  → { ok, message, connected_at, conexao: { tentou, ok, reason, mensagem, url, atualizado_em }, checklist }   (botão "Conectar"; settings.account)
// O CRM entrega ao UTMpay o endereço dos avisos e o segredo JÁ SALVOS ({base_url}/api/integracoes/crm, com a chave de acesso). Nada vem do corpo: o
// endereço do UTMpay, a chave e o segredo são os guardados (cifrados) na conta, e nunca voltam ao navegador. Mensagens dizem o que fazer.
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST() {
  const auth = await guardPermission("settings.account");
  if (!auth.ok) return auth.response;
  const { accountId, userId } = auth.ctx;

  const limit = await checkRateLimit(`utmpay-connect:${userId}`, RATE_LIMITS.utmpayTest);
  if (!limit.success) return rateLimitResponse(limit);

  const stored = await loadStoredCredentials(supabaseAdmin(), accountId);
  if (!stored.ok) {
    if (stored.unavailable) return NextResponse.json({ error: "O rastreamento ainda não está disponível neste ambiente. Peça ao suporte para atualizar o banco de dados.", code: "utmpay_unavailable" }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ error: "Não foi possível ler a configuração agora. Tente de novo." }, { status: 500, headers: NO_STORE });
  }
  const { row, baseUrl, apiKey, secret } = stored.value;
  const eventsUrl = utmpayEventsUrl();
  const conexao = await connectUtmpay({ baseUrl, apiKey, secret, eventsUrl });
  if (conexao.tentou) {
    await logAuditEvent({
      accountId,
      eventType: "action",
      resourceType: "utmpay_config",
      resourceId: accountId,
      resourceLabel: "UTMpay",
      action: conexao.ok ? "utmpay.connected" : "utmpay.connect_failed",
      summary: conexao.ok ? "UTMpay conectado ao CRM (botão Conectar)" : "Tentativa de conectar o UTMpay ao CRM falhou (botão Conectar)",
      metadata: { ok: conexao.ok, reason: conexao.reason },
    });
  }
  const view = viewUtmpayConfig(row, true, eventsUrl);
  return NextResponse.json(
    { ok: conexao.ok, message: conexao.mensagem, connected_at: conexao.ok ? (conexao.atualizado_em ?? new Date().toISOString()) : null, conexao, checklist: buildChecklist(view, connectionFromResult(conexao, eventsUrl)) },
    { headers: NO_STORE },
  );
}
