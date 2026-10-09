import { guardPermission } from '@/lib/auth/route-guard';
import { getEndpoint, rotateSecret } from '@/lib/webhooks-out/endpoints';
import { auditWebhook, notFoundResponse, validId, webhookRoute } from '../../handler';

// Novo segredo, devolvido UMA vez; o anterior deixa de valer na hora.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validId(id)) return notFoundResponse();
  return webhookRoute(await guardPermission('api_keys.manage'), async ({ db, accountId }) => {
    const out = await rotateSecret(db, accountId, id);
    const current = await getEndpoint(db, accountId, id);
    // Auditoria sem o segredo (que só volta nesta resposta).
    await auditWebhook({ accountId, action: 'secret_rotated', endpointId: id, url: current.url });
    return out;
  });
}
