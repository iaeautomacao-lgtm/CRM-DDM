import { agentRoute } from '../handler';
import { previewAgent } from '@/lib/ai/agents/service';
export async function POST(request: Request) {
  return agentRoute('ai.agents.view', async (ctx) =>
    previewAgent(ctx.accountId, await request.json().catch(() => null))
  );
}
