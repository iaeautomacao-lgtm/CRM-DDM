// POST /api/settings/agents/[id]/simulate (TASK1-C): permissão, fluxo sintético, rascunho do agente sem salvar,
// política de consulta real (secrets.write) e resposta resumida sem CPF. O motor do simulador tem o próprio
// teste (simulator.test.ts); aqui ele é substituído para conferir a fiação da rota.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can, type Permission } from '@/lib/auth/permissions';
import type { AccountRole } from '@/lib/auth/roles';
import type { SimulateRequest, SimulateResponse } from '@/lib/flows/simulator/types';

const ACCOUNT = '00000000-0000-0000-0000-00000000000a';
const AGENT = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({ role: 'admin' as string }));
const deps = vi.hoisted(() => ({
  buildSimulationAgent: vi.fn(),
  simulateTurn: vi.fn(),
  loadSimulationAccountData: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: ACCOUNT, userId: 'user-1', role: state.role }),
  toErrorResponse: () => new Response(null, { status: 401 }),
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: deps.checkRateLimit }));
vi.mock('@/lib/flows/simulator/run', () => ({ simulateTurn: deps.simulateTurn }));
vi.mock('@/lib/flows/simulator/seed', () => ({ loadSimulationAccountData: deps.loadSimulationAccountData }));
vi.mock('@/lib/ai/agents/service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildSimulationAgent: deps.buildSimulationAgent,
}));

const { POST } = await import('./route');
const { AgentServiceError, SIM_NEW_AGENT_ID } = await import('@/lib/ai/agents/service');

const DRAFT = { config: {}, prompt_content: 'p', composition: 'sections_v1', rules: [], tool_ids: [], knowledge: { selection_mode: 'legacy_account_all' } };
const call = (id: string, body: unknown) =>
  POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  state.role = 'admin';
  deps.checkRateLimit.mockResolvedValue({ success: true, remaining: 29, reset: Date.now() + 60_000 });
  deps.loadSimulationAccountData.mockResolvedValue({ aiConfig: { api_provider: 'openai' }, knowledgeBase: [], teams: [], aiTools: [], accountSecrets: [] });
  deps.buildSimulationAgent.mockImplementation(async (_acc: string, agentId: string | null) => ({
    agentId: agentId ?? SIM_NEW_AGENT_ID,
    name: 'Agente Teste',
    version: 3,
    disabled: false,
    seed: { agents: [], versions: [], ruleVersions: [] },
  }));
  deps.simulateTurn.mockImplementation(async (): Promise<Omit<SimulateResponse, 'remaining'>> => ({
    state: { version: 1, tables: {}, clock: 1, seq: 1 },
    outbound: [{ id: 'o1', at: 'x', kind: 'text', provider: 'meta', source: 'ia', text: 'Olá!' }],
    timeline: [
      { at: '2026-10-09T12:00:00Z', type: 'tool_call', node_key: 'agente', label: 'Tool chamada: localizar_devedor', detail: { cpf: '52998224725' } },
    ],
    run: { id: 'r', status: 'active', current_node_key: 'agente', vars: { cpf: '529.982.247-25' }, end_reason: null },
    path: ['inicio', 'agente'],
    dispatch: { consumed: true, outcome: 'started' },
  }));
});

describe('POST /api/settings/agents/[id]/simulate', () => {
  it('roda o rascunho no fluxo sintético de um nó, sem salvar, e devolve o resumo sem CPF', async () => {
    const res = await call(AGENT, { agent: DRAFT, message: { kind: 'text', text: 'Oi' }, state: null });
    expect(res.status).toBe(200);
    expect(deps.buildSimulationAgent).toHaveBeenCalledWith(ACCOUNT, AGENT, DRAFT);
    const [req, seed] = deps.simulateTurn.mock.calls[0] as [SimulateRequest, Record<string, unknown>];
    expect(req.draft.nodes.map((n) => [n.node_key, n.node_type, n.config])).toEqual([
      ['inicio', 'start', { next_node_key: 'agente' }],
      ['agente', 'ai_agent', { agent_id: AGENT }],
    ]);
    expect(req.ignoreTrigger).toBe(true);
    expect(seed).toMatchObject({ accountId: ACCOUNT, flowId: AGENT, aiConfig: { api_provider: 'openai' } });
    // RAG vetorial (TASK1-D): o teste do agente usa a mesma busca por trechos da produção.
    expect(typeof seed.knowledgeRetriever).toBe('function');
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('52998224725');
    expect(JSON.stringify(body)).not.toContain('529.982.247-25');
    expect(body.timeline[0].detail).toEqual({ cpf: '***.***.***-25' });
    expect(body.agent).toEqual({ name: 'Agente Teste', version: 3, disabled: false });
    expect(body.remaining).toBe(29);
  });

  it('agente novo (id "new") usa o id sintético', async () => {
    await call('new', { agent: DRAFT, message: { kind: 'text', text: 'Oi' } });
    expect(deps.buildSimulationAgent).toHaveBeenCalledWith(ACCOUNT, null, DRAFT);
    const [req] = deps.simulateTurn.mock.calls[0] as [SimulateRequest];
    expect(req.draft.nodes[1].config).toEqual({ agent_id: SIM_NEW_AGENT_ID });
  });

  it('supervisor testa, mas a consulta real é descartada (exige secrets.write)', async () => {
    state.role = 'supervisor';
    const res = await call(AGENT, { agent: DRAFT, message: { kind: 'text', text: 'Oi' }, realReadOnlyTools: ['localizar_devedor'] });
    expect(res.status).toBe(200);
    const [req] = deps.simulateTurn.mock.calls[0] as [SimulateRequest];
    expect(req.realReadOnlyTools).toEqual([]);
    expect((await res.json()).real_read_denied).toBe(true);
  });

  it.each(['agent', 'viewer'])('%s não testa (403)', async (role) => {
    state.role = role;
    const perms: Permission[] = ['flows.simulate', 'ai.agents.view'];
    expect(perms.every((p) => can({ role: role as AccountRole }, p))).toBe(false);
    expect((await call(AGENT, { agent: DRAFT, message: { kind: 'text', text: 'Oi' } })).status).toBe(403);
    expect(deps.simulateTurn).not.toHaveBeenCalled();
  });

  it('id inválido → 404; sem rascunho ou sem mensagem → 400', async () => {
    expect((await call('nao-e-uuid', { agent: DRAFT, message: { kind: 'text', text: 'Oi' } })).status).toBe(404);
    expect((await call(AGENT, { message: { kind: 'text', text: 'Oi' } })).status).toBe(400);
    expect((await call(AGENT, { agent: DRAFT, message: { kind: 'text', text: '  ' } })).status).toBe(400);
    expect(deps.simulateTurn).not.toHaveBeenCalled();
  });

  it('rascunho inválido devolve o erro do serviço (com o campo)', async () => {
    deps.buildSimulationAgent.mockRejectedValueOnce(new AgentServiceError('Configuração inválida.', 400, [{ path: 'llm.model', message: 'x' }]));
    const res = await call(AGENT, { agent: DRAFT, message: { kind: 'text', text: 'Oi' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Configuração inválida.', issues: [{ path: 'llm.model', message: 'x' }] });
  });

  it('limite de custo compartilhado com o simulador de fluxo → 429', async () => {
    deps.checkRateLimit.mockResolvedValueOnce({ success: false, remaining: 0, reset: Date.now() + 120_000 });
    const res = await call(AGENT, { agent: DRAFT, message: { kind: 'text', text: 'Oi' } });
    expect(res.status).toBe(429);
    expect(deps.checkRateLimit).toHaveBeenCalledWith('flows:simulate:user-1', expect.anything());
  });
});
