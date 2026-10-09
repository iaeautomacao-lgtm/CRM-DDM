import { guardPermission } from '@/lib/auth/route-guard';
import { enqueueTest } from '@/lib/webhooks-out/endpoints';
import { auditWebhook, notFoundResponse, validId, webhookRoute } from '../../handler';

// Enfileira um `webhook.test` só para este endpoint; o resultado aparece nas entregas.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validId(id)) return notFoundResponse();
  return webhookRoute(
    await guardPermission('api_keys.manage'),
    async ({ db, accountId }) => {
      const out = await enqueueTest(db, accountId, id);
      await auditWebhook({ accountId, action: 'tested', endpointId: id, deliveryId: out.delivery_id });
      return out;
    },
    202,
  );
}
