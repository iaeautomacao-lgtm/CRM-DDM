import { NextResponse } from 'next/server';
import { guardPermission } from '@/lib/auth/route-guard';
import type { Permission } from '@/lib/auth/permissions';
import type { AccountContext } from '@/lib/auth/account';
import { AgentServiceError } from '@/lib/ai/agents/service';
export async function agentRoute(
  permission: Extract<Permission, 'ai.agents.view' | 'ai.agents.edit'>,
  action: (ctx: AccountContext) => Promise<unknown>,
  status = 200
) {
  const auth = await guardPermission(permission);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await action(auth.ctx), { status });
  } catch (err) {
    if (err instanceof AgentServiceError)
      return NextResponse.json(
        { error: err.message, ...(err.issues ? { issues: err.issues } : {}) },
        { status: err.status }
      );
    console.error('[settings/agents] falha interna');
    return NextResponse.json(
      { error: 'Não foi possível concluir a operação.' },
      { status: 500 }
    );
  }
}
export type AgentRouteContext = { params: Promise<{ id: string }> };
