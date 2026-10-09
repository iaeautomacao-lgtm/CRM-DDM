import { guardPermission } from '@/lib/auth/route-guard';
import { listDeliveries } from '@/lib/webhooks-out/endpoints';
import { notFoundResponse, validId, webhookRoute } from '../../handler';

// Entregas do endpoint, mais recentes primeiro (?state=pending|sending|delivered|dead, ?cursor, ?limit≤200).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validId(id)) return notFoundResponse();
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '');
  return webhookRoute(await guardPermission('api_keys.manage'), ({ db, accountId }) =>
    listDeliveries(db, accountId, id, {
      state: url.searchParams.get('state'),
      cursor: url.searchParams.get('cursor'),
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    }),
  );
}
