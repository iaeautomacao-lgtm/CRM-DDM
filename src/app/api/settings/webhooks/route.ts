import { guardPermission } from '@/lib/auth/route-guard';
import { readJsonObject } from '@/lib/webhooks-out/http';
import { createEndpoint, listEndpoints } from '@/lib/webhooks-out/endpoints';
import { MAX_ENDPOINTS_PER_ACCOUNT, WEBHOOK_EVENT_DESCRIPTIONS, WEBHOOK_EVENTS } from '@/lib/webhooks-out/catalog';
import { auditWebhook, webhookRoute } from './handler';

// GET: endpoints da conta + catálogo de eventos (para o formulário). POST: cadastra; o segredo volta UMA vez.

export async function GET() {
  return webhookRoute(await guardPermission('api_keys.manage'), async ({ db, accountId }) => ({
    endpoints: await listEndpoints(db, accountId),
    events: WEBHOOK_EVENTS.map((id) => ({ id, description: WEBHOOK_EVENT_DESCRIPTIONS[id] })),
    max_endpoints: MAX_ENDPOINTS_PER_ACCOUNT,
  }));
}

export async function POST(request: Request) {
  return webhookRoute(await guardPermission('api_keys.manage'), async ({ db, accountId }) => {
    const body = await readJsonObject(request);
    const created = await createEndpoint(db, { accountId, keyId: null, url: body.url, events: body.events, description: body.description });
    await auditWebhook({ accountId, action: 'created', endpointId: created.id, url: created.url, events: created.events });
    return created;
  }, 201);
}
