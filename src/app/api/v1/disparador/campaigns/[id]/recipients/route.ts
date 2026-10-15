// ============================================================
// GET /api/v1/disparador/campaigns/[id]/recipients — status por destinatário da campanha, para conciliação (ERP de cobrança).
//
// Requer 'campaigns:read' OU 'campaigns:write'. Extração de dado pessoal (telefone, nome): 60 req/min por chave + auditoria (só
// quantidade, nunca o conteúdo). Campanha de outra conta = 404.
// Filtros: status (vírgula), replied, clicked/closed/paid (rastreio UTMpay), phone. limit 1..500 (padrão 100), cursor.
// Fora: CPF, texto final da mensagem, erro técnico cru.
// ============================================================

import { requireApiKey } from "@/lib/auth/api-context";
import { ok, notFound, badRequest, payloadTooLarge, rateLimited, toApiErrorResponse, type ApiCallLogContext } from "@/lib/api/v1/respond";
import { appendRecipients } from "@/lib/api/v1/campaign-append";
import { MAX_BODY_BYTES } from "@/lib/disparador/api-v1-campaign";
import { runIdempotentSend } from "@/lib/disparador/send-ledger";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logAuditEvent } from "@/lib/audit/log-event";
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

// POST /api/v1/disparador/campaigns/[id]/recipients — adiciona contatos a uma campanha JÁ CRIADA PELA API (escopo campaigns:write).
// Corpo: { contacts: [{ phone, variables, reference? }] } (até 20.000 por chamada; a campanha não passa de 50.000). Idempotency-Key OBRIGATÓRIA:
// repetir a mesma chamada devolve a mesma resposta, sem inserir de novo (e, se uma tentativa falhar no meio, repetir completa só acrescenta
// o que faltou: a deduplicação contra a campanha é por telefone). Só campanha em execução ou pausada (409 nos demais estados).
// Mesmas regras do create: blacklist, números inválidos, variáveis, janela, ritmo da própria campanha, número vermelho e template aprovado.
// Limite: o mesmo de criar campanha (6/min por chave). Exige as migrations 357 e 358 (sem elas, 503).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const logCtx: ApiCallLogContext = { method: "POST", route: "/api/v1/disparador/campaigns/[id]/recipients", startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, "campaigns:write");
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    if (!isUuid(campaignId)) throw notFound("Campanha não encontrada");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw payloadTooLarge("Corpo da requisição acima de 15 MB; divida os contatos em várias chamadas");

    return await runIdempotentSend(
      ctx.accountId,
      request,
      async () => {
        // Repetição idempotente já voltou do ledger e não gasta o orçamento.
        const limit = await checkRateLimit(`api-v1-campaigns:${ctx.keyId}`, RATE_LIMITS.apiV1CampaignCreate);
        if (!limit.success) throw rateLimited(limit, { accountId: ctx.accountId, keyId: ctx.keyId });
        const raw = await request.text();
        if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw payloadTooLarge("Corpo da requisição acima de 15 MB; divida os contatos em várias chamadas");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw badRequest("Corpo da requisição não é um JSON válido");
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("Corpo da requisição deve ser um objeto JSON");
        const contacts = (parsed as { contacts?: unknown }).contacts;
        if (!Array.isArray(contacts)) throw badRequest("'contacts' é obrigatório e deve ser uma lista");

        const result = await appendRecipients(supabaseAdmin(), { accountId: ctx.accountId, campaignId, contacts });
        if (result.added > 0) {
          // Só contagens: nunca telefone, referência ou variável no log de auditoria.
          await logAuditEvent({
            accountId: ctx.accountId,
            eventType: "action",
            resourceType: "campaign",
            resourceId: campaignId,
            action: "campaign.recipients_added",
            summary: `Pela API, ${result.added} destinatário(s) adicionado(s) à campanha`,
            metadata: { key_id: ctx.keyId, origin: "api", added: result.added, duplicates: result.duplicates, invalid: result.invalid },
          });
        }
        return ok(result, 200, logCtx);
      },
      { apiEnvelope: true },
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
