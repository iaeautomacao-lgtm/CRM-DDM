// ============================================================
// GET /api/v1/disparador/campaigns/[id]/recipients — status por destinatário da campanha, para conciliação (ERP de cobrança).
//
// Requer 'campaigns:read' OU 'campaigns:write'. Extração de dado pessoal (telefone, nome): 60 req/min por chave + auditoria (só
// quantidade, nunca o conteúdo). Campanha de outra conta = 404.
// Filtros: status (vírgula), replied, clicked/closed/paid (rastreio UTMpay), phone. limit 1..500 (padrão 100), cursor.
// Fora: CPF, texto final da mensagem, erro técnico cru.
// ============================================================

import { requireApiKey } from "@/lib/auth/api-context";
import { ok, notFound, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { enforceExtractRateLimit, isUuid, parseLimit } from "@/lib/api/v1/extract";
import { auditExtraction } from "@/lib/api/v1/extract-audit";
import {
  decodeRecipientCursor,
  hasFunnelFilter,
  loadRecipientPage,
  parseRecipientFilters,
  RECIPIENTS_DEFAULT,
  RECIPIENTS_MAX,
} from "@/lib/api/v1/campaign-api";
import { loadContactConversationIds } from "@/lib/disparador/queue-details-rows";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const logCtx: ApiCallLogContext = { method: "GET", route: "/api/v1/disparador/campaigns/[id]/recipients", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, ["campaigns:read", "campaigns:write"]);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    await enforceExtractRateLimit(ctx);
    if (!isUuid(campaignId)) throw notFound("Campanha não encontrada");

    const search = new URL(request.url).searchParams;
    const filters = parseRecipientFilters(search);
    const limit = parseLimit(search.get("limit"), RECIPIENTS_DEFAULT, RECIPIENTS_MAX);
    const cursor = decodeRecipientCursor(search.get("cursor"), hasFunnelFilter(filters));

    const db = supabaseAdmin();
    const { data: found, error: campaignError } = await db.from("campaigns").select("id").eq("id", campaignId).eq("account_id", ctx.accountId).limit(1);
    if (campaignError) throw campaignError;
    if (!found?.[0]) throw notFound("Campanha não encontrada");

    const page = await loadRecipientPage(db, {
      accountId: ctx.accountId,
      campaignId,
      filters,
      cursor,
      limit,
      conversationsFor: async (rows) =>
        loadContactConversationIds(ctx.accountId, campaignId, rows.map((r) => r.contact_id).filter((id): id is string => !!id)),
    });
    await auditExtraction({
      accountId: ctx.accountId,
      keyId: ctx.keyId,
      route: "/api/v1/disparador/campaigns/[id]/recipients",
      filters: { campaign_id: campaignId, status: filters.statuses.join(","), replied: filters.replied, clicked: filters.clicked, closed: filters.closed, paid: filters.paid, phone: filters.phone },
      itemCount: page.items.length,
    });
    return ok(page, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
