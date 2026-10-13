import { logAuditEvent } from '@/lib/audit/log-event';

/**
 * Auditoria de cada extração (TASK38): chave, rota, filtros e QUANTIDADE de itens. Nunca o conteúdo (texto, telefone, nomes).
 * Vai para wacrm.audit_logs (tela de auditoria da conta). Nunca derruba a resposta: logAuditEvent só registra o erro.
 */
export async function auditExtraction(args: {
  accountId: string;
  keyId: string;
  route: string;
  filters: Record<string, unknown>;
  itemCount: number;
}): Promise<void> {
  // Só filtros com valor, e telefone mascarado: o log não guarda dado pessoal do contato.
  const filters: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.filters)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    filters[k] = k === 'phone' ? 'informado' : v;
  }
  await logAuditEvent({
    accountId: args.accountId,
    eventType: 'action',
    resourceType: 'api_key',
    resourceId: args.keyId,
    action: 'api.extraction',
    summary: `Extração pela API v1: ${args.route} (${args.itemCount} itens)`,
    metadata: { key_id: args.keyId, route: args.route, filters, item_count: args.itemCount },
  });
}
