import { guardPermission } from '@/lib/auth/route-guard';
import { replayDelivery } from '@/lib/webhooks-out/endpoints';
import { auditWebhook, notFoundResponse, validId, webhookRoute } from '../../../../handler';

// Reenvia uma entrega 'dead' deste webhook (409 para outros estados).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; deliveryId: string }> }) {
  const { id, deliveryId } = await params;
  if (!validId(id) || !validId(deliveryId)) return notFoundResponse();
  return webhookRoute(await guardPermission('api_keys.manage'), async ({ db, accountId }) => {
    await replayDelivery(db, accountId, id, deliveryId);
    await auditWebhook({ accountId, action: 'delivery_replayed', endpointId: id, deliveryId });
    return { id: deliveryId, replayed: true };
  }, 202);
}
