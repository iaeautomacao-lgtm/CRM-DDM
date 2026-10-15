// ============================================================
// GET  /api/v1/contacts — busca de contatos da conta da chave (escopo contacts:read ou contacts:write). Exige ao menos um filtro:
//      phone (tolera telefones alternativos), cpf (exato; pode devolver vários), email, q (prefixo do nome, 3+ letras), tag (nome),
//      updated_from/updated_to. Ordem (updated_at, id) crescente, cursor, limit 1..200 (padrão 50). 60 req/min por chave. Auditada.
//      O CPF nunca sai em claro (cpf_masked, has_cpf).
// POST /api/v1/contacts — upsert (escopo contacts:write). Identidade: CPF, depois telefone. Existente: preenche SÓ o que está vazio e
//      nunca troca o telefone principal. 201 created:true / 200 created:false + updated_fields.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { ok, badRequest, rateLimited, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { auditExtraction } from '@/lib/api/v1/extract-audit';
import { contactsCursor, parseContactWrite, parseContactsQuery, serializeApiContact } from '@/lib/api/v1/contacts';
import { extrasOf, listContacts, loadExtras, resolveActorUserId, upsertContact } from '@/lib/api/v1/contacts-db';

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'GET', route: '/api/v1/contacts', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, ['contacts:read', 'contacts:write']);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const limit = await checkRateLimit(`apikey-contacts:${ctx.keyId}`, RATE_LIMITS.apiV1ContactsRead);
    if (!limit.success) throw rateLimited(limit, { accountId: ctx.accountId, keyId: ctx.keyId });

    const q = parseContactsQuery(new URL(request.url).searchParams);
    const { rows, hasMore } = await listContacts(ctx.supabase, ctx.accountId, q);
    const extras = await loadExtras(ctx.supabase, rows);
    const last = rows[rows.length - 1];
    await auditExtraction({
      accountId: ctx.accountId,
      keyId: ctx.keyId,
      route: '/api/v1/contacts',
      filters: { phone: q.phone, cpf: q.cpf ? 'informado' : null, email: q.email ? 'informado' : null, q: q.q ? 'informado' : null, tag: q.tag, updated_from: q.updatedFrom, updated_to: q.updatedTo },
      itemCount: rows.length,
    });
    return ok(
      {
        items: rows.map((r) => serializeApiContact(r, extras.get(r.id)!)),
        next_cursor: hasMore && last ? contactsCursor(last) : null,
      },
      200,
      logCtx
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export async function POST(request: Request) {
  const logCtx: ApiCallLogContext = { method: 'POST', route: '/api/v1/contacts', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;

    // Idempotency-Key é opcional: o upsert já é idempotente por identidade (CPF/telefone) e só preenche vazios; repetir a chamada devolve
    // o mesmo contato com created:false e updated_fields vazio. A chave é validada, mas nenhuma resposta é guardada.
    const idem = request.headers.get('idempotency-key');
    if (idem !== null && !IDEMPOTENCY_KEY_RE.test(idem)) throw badRequest('Idempotency-Key inválida (8 a 128 caracteres: letras, números e . _ : -)');

    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Corpo da requisição deve ser um objeto JSON válido');
    const write = parseContactWrite(body as Record<string, unknown>, 'upsert');

    const actor = await resolveActorUserId(ctx.supabase, ctx.accountId, ctx.createdBy, ctx.userId);
    const result = await upsertContact(ctx.supabase, { accountId: ctx.accountId, actor, write });
    const extras = await extrasOf(ctx.supabase, result.contact);
    return ok(
      {
        contact: serializeApiContact(result.contact, extras),
        created: result.created,
        updated_fields: result.updatedFields,
        ignored_phones: result.ignoredPhones,
      },
      result.created ? 201 : 200,
      logCtx
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
