// PUT /api/v1/contacts/{id}/owner { assignee_id } — define o atendente-dono do contato (carteira fixa). DELETE remove. Escopo contacts:write. Idempotente.
// Fase 1: só cadastro (a distribuição automática não muda); POST /conversations usa o dono quando não vem atendente nem equipe. 404 para contato ou
// atendente de outra conta (ou desativado). Sem a migration 372: 503.
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, notFound, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';
import { isContactId } from '@/lib/api/v1/contacts';
import { isUuid } from '@/lib/api/v1/conversations-parse';
import { setContactOwner } from '@/lib/api/v1/contact-owner';
import { registerAuditActor } from '@/lib/audit/context';

async function handle(request: Request, params: Promise<{ id: string }>, method: 'PUT' | 'DELETE') {
  const logCtx: ApiCallLogContext = { method, route: '/api/v1/contacts/{id}/owner', startedAt: Date.now() };
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const { id } = await params;
    if (!isContactId(id)) throw notFound('Contato não encontrado');

    let assigneeId: string | null = null;
    if (method === 'PUT') {
      const body: unknown = await request.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Corpo da requisição deve ser um objeto JSON válido');
      const b = body as Record<string, unknown>;
      const extra = Object.keys(b).filter((k) => k !== 'assignee_id');
      if (extra.length > 0) throw badRequest(`Campo(s) desconhecido(s): ${extra.join(', ')}. Aceito: assignee_id`);
      if (!isUuid(b.assignee_id)) throw badRequest("'assignee_id' é obrigatório e deve ser um id (UUID); veja GET /agents");
      assigneeId = b.assignee_id;
    }
    await registerAuditActor({ actorType: 'api', source: 'api_v1' });
    return ok(await setContactOwner(ctx.supabase, ctx.accountId, id, assigneeId), 200, logCtx);
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'PUT');
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'DELETE');
}
