import { NextResponse } from 'next/server';
import { guardRole } from '@/lib/auth/route-guard';
import type { AccountContext } from '@/lib/auth/account';
import { AgentServiceError } from '@/lib/ai/agents/service';
export async function agentRoute(
  role: 'supervisor' | 'admin',
  action: (ctx: AccountContext) => Promise<unknown>,
  status = 200
) {
  const auth = await guardRole(role);
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
