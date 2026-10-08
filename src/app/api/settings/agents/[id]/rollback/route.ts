import { agentRoute, type AgentRouteContext } from '../../handler';
import { rollbackAgent } from '@/lib/ai/agents/service';
export async function POST(request: Request, { params }: AgentRouteContext) {
  return agentRoute('ai.agents.edit', async (ctx) =>
    rollbackAgent(
      ctx.accountId,
      ctx.userId,
      (await params).id,
      await request.json().catch(() => null)
    )
  );
}
