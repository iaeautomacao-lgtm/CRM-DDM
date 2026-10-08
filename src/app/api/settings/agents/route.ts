import { agentRoute } from './handler';
import { listAgents, publishAgent } from '@/lib/ai/agents/service';
export async function GET() {
  return agentRoute('supervisor', (ctx) => listAgents(ctx.accountId));
}
export async function POST(request: Request) {
  return agentRoute(
    'admin',
    async (ctx) => {
      const result = await publishAgent(
        ctx.accountId,
        ctx.userId,
        await request.json().catch(() => null)
      );
      return { agent_id: result.agent_id, version_id: result.version_id };
    },
    201
  );
}
