// ============================================================
// GET   /api/v1/contacts/{id} — um contato da conta da chave (escopo contacts:read ou contacts:write); de outra conta = 404.
// PATCH /api/v1/contacts/{id} — altera (escopo contacts:write). SOBRESCREVE os campos enviados: null limpa e-mail, empresa e instituição;
//       nome vazio e telefone principal não mudam; `phones` vira a lista exata de alternativos (número de outro contato = 409);
//       `tags: { add, remove }`; `custom_fields` faz merge (null apaga; nome inexistente = 422). O CPF nunca sai em claro.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { ok, badRequest, notFound, rateLimited, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { isContactId, parseContactWrite, serializeApiContact } from '@/lib/api/v1/contacts';
import { extrasOf, getContactRow, patchContact, resolveActorUserId } from '@/lib/api/v1/contacts-db';

const NOT_FOUND = 'Contato não encontrado';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const logCtx: ApiCallLogContext = { method: 'GET', route: '/api/v1/contacts/{id}', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, ['contacts:read', 'contacts:write']);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const limit = await checkRateLimit(`apikey-contacts:${ctx.keyId}`, RATE_LIMITS.apiV1ContactsRead);
    if (!limit.success) throw rateLimited(limit, { accountId: ctx.accountId, keyId: ctx.keyId });

    const { id } = await params;
    if (!isContactId(id)) throw notFound(NOT_FOUND);
    const row = await getContactRow(ctx.supabase, ctx.accountId, id);
    if (!row) throw notFound(NOT_FOUND);
    return ok({ contact: serializeApiContact(row, await extrasOf(ctx.supabase, row)) }, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const logCtx: ApiCallLogContext = { method: 'PATCH', route: '/api/v1/contacts/{id}', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;

    const { id } = await params;
    if (!isContactId(id)) throw notFound(NOT_FOUND);
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Corpo da requisição deve ser um objeto JSON válido');
    const write = parseContactWrite(body as Record<string, unknown>, 'patch');

    const actor = await resolveActorUserId(ctx.supabase, ctx.accountId, ctx.createdBy, ctx.userId);
    const result = await patchContact(ctx.supabase, { accountId: ctx.accountId, actor, id, write });
    if (!result) throw notFound(NOT_FOUND);
    return ok({ contact: serializeApiContact(result.contact, await extrasOf(ctx.supabase, result.contact)), updated_fields: result.updatedFields }, 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
