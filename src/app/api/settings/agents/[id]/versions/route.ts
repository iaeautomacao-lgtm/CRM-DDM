import { agentRoute, type AgentRouteContext } from '../../handler';
import { publishAgent } from '@/lib/ai/agents/service';
export async function POST(request: Request, { params }: AgentRouteContext) {
  return agentRoute('ai.agents.edit', async (ctx) => {
    const result = await publishAgent(
      ctx.accountId,
      ctx.userId,
      await request.json().catch(() => null),
      (await params).id
    );
    return { version_id: result.version_id, version: result.version };
  });
}
