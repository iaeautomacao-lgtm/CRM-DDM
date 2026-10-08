import { agentRoute, type AgentRouteContext } from '../handler';
import {
  getAgent,
  patchAgent,
  deleteAgent,
  AgentServiceError,
} from '@/lib/ai/agents/service';
export async function GET(_request: Request, { params }: AgentRouteContext) {
  return agentRoute('ai.agents.view', async (ctx) =>
    getAgent(ctx.accountId, (await params).id)
  );
}
export async function PATCH(request: Request, { params }: AgentRouteContext) {
  return agentRoute('ai.agents.edit', async (ctx) =>
    patchAgent(
      ctx.accountId,
      (await params).id,
      await request.json().catch(() => null)
    )
  );
}
export async function DELETE(request: Request, { params }: AgentRouteContext) {
  return agentRoute('ai.agents.edit', async (ctx) => {
    if (new URL(request.url).searchParams.has('force'))
      throw new AgentServiceError('Exclusão forçada não é permitida.');
    return deleteAgent(ctx.accountId, (await params).id);
  });
}
