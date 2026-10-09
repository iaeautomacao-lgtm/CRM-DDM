import { guardPermission } from '@/lib/auth/route-guard';
import { readJsonObject } from '@/lib/webhooks-out/http';
import { deleteEndpoint, getEndpoint, updateEndpoint } from '@/lib/webhooks-out/endpoints';
import { auditWebhook, notFoundResponse, validId, webhookRoute } from '../handler';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!validId(id)) return notFoundResponse();
  return webhookRoute(await guardPermission('api_keys.manage'), ({ db, accountId }) => getEndpoint(db, accountId, id));
}

/** url, events, description ou status (active | paused). */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  if (!validId(id)) return notFoundResponse();
  return webhookRoute(await guardPermission('api_keys.manage'), async ({ db, accountId }) => {
    const patch = await readJsonObject(request);
    const updated = await updateEndpoint(db, accountId, id, patch);
    await auditWebhook({
      accountId,
      action: 'updated',
      endpointId: id,
      url: updated.url,
      events: patch.events !== undefined ? updated.events : undefined,
      changedFields: Object.keys(patch).filter((k) => ['url', 'events', 'description', 'status'].includes(k)),
      status: patch.status !== undefined ? updated.status : undefined,
    });
    return updated;
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!validId(id)) return notFoundResponse();
  return webhookRoute(await guardPermission('api_keys.manage'), async ({ db, accountId }) => {
    const current = await getEndpoint(db, accountId, id);
    await deleteEndpoint(db, accountId, id);
    await auditWebhook({ accountId, action: 'deleted', endpointId: id, url: current.url });
    return { id, deleted: true };
  });
}
