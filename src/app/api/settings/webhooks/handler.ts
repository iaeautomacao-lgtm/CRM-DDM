// /api/settings/webhooks/* — os mesmos webhooks de saída de /api/v1/webhooks (PRD 15, 15.14), mas pela SESSÃO do
// painel (a v1 só aceita chave de API). Reaproveita src/lib/webhooks-out/endpoints.ts: mesmas validações, segredo
// devolvido uma vez, cadastro sem chave de origem (created_by_key = null). Permissão: api_keys.manage (admin+).

import { NextResponse } from 'next/server';

import type { GuardResult } from '@/lib/auth/route-guard';
import { ApiError } from '@/lib/api/v1/respond';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/webhooks-out/http';
import { logAuditEvent, type AuditEventParams } from '@/lib/audit/log-event';

export type WebhookRouteCtx = { accountId: string; db: ReturnType<typeof supabaseAdmin> };

/** `auth` = guardPermission('api_keys.manage') chamado na própria rota (a matriz de permissões confere no arquivo). */
export async function webhookRoute(auth: GuardResult, run: (ctx: WebhookRouteCtx) => Promise<unknown>, status = 200) {
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await run({ accountId: auth.ctx.accountId, db: supabaseAdmin() }), { status });
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    console.error('[settings/webhooks] falha:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Não foi possível concluir a operação.' }, { status: 500 });
  }
}

/** Id do endpoint/entrega válido; senão a rota responde 404 sem tocar no banco. */
export function validId(id: string): boolean {
  return UUID_RE.test(id);
}

export const notFoundResponse = () => NextResponse.json({ error: 'Webhook não encontrado.' }, { status: 404 });

type AuditAction = 'created' | 'updated' | 'deleted' | 'secret_rotated' | 'tested' | 'delivery_replayed';

const AUDIT_SUMMARY: Record<AuditAction, string> = {
  created: 'Webhook de saída cadastrado',
  updated: 'Webhook de saída alterado',
  deleted: 'Webhook de saída removido',
  secret_rotated: 'Segredo do webhook de saída trocado',
  tested: 'Teste do webhook de saída enviado',
  delivery_replayed: 'Entrega do webhook de saída reenviada',
};

/**
 * Evento de auditoria de um webhook (PRD 20.8: nunca o segredo). Guarda o host da URL, os eventos e, na alteração,
 * só os NOMES dos campos e o novo status.
 */
export function webhookAuditEvent(input: {
  accountId: string;
  action: AuditAction;
  endpointId: string;
  url?: string | null;
  events?: string[];
  changedFields?: string[];
  status?: string;
  deliveryId?: string;
}): AuditEventParams {
  let host: string | null = null;
  try {
    host = input.url ? new URL(input.url).host : null;
  } catch {
    host = null;
  }
  const metadata: Record<string, unknown> = {};
  if (host) metadata.host = host;
  if (input.events) metadata.events = input.events;
  if (input.changedFields) metadata.fields = input.changedFields;
  if (input.status) metadata.status = input.status;
  if (input.deliveryId) metadata.delivery_id = input.deliveryId;
  return {
    accountId: input.accountId,
    eventType:
      input.action === 'created' ? 'created' : input.action === 'deleted' ? 'deleted' : input.action === 'updated' ? 'updated' : 'action',
    resourceType: 'webhook_endpoint',
    resourceId: input.endpointId,
    resourceLabel: host ?? undefined,
    action: `webhook.${input.action}`,
    summary: host ? `${AUDIT_SUMMARY[input.action]}: ${host}` : AUDIT_SUMMARY[input.action],
    metadata,
  };
}

export async function auditWebhook(input: Parameters<typeof webhookAuditEvent>[0]): Promise<void> {
  await logAuditEvent(webhookAuditEvent(input));
}
