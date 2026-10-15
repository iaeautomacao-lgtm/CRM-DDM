import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pausar / cancelar / retomar (campaign-control.ts): estado, idempotência, guardas do resume e gravação do motivo.
const approved = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock('@/lib/disparador/template-pause', async (orig) => ({ ...(await orig<typeof import('@/lib/disparador/template-pause')>()), allTemplatesApproved: approved }));
vi.mock('@/lib/disparador/queue-moves', () => ({ drainDispatchMoves: vi.fn(async () => ({ ok: true, moved: 0, partial: false })) }));

import { cancelCampaign, pauseCampaign, resumeCampaign } from './campaign-control';

type State = { id: string; status: string; pausa_automatica_motivo: string | null; mensagens: unknown };
let state: State | null;
let rpcResult: { data: boolean | null; error: { message: string } | null };
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
let updates: Array<Record<string, unknown>>;
let updateError: { code?: string; message: string } | null;
let afterRpcStatus: string | null;

function makeDb() {
  return {
    from: () => {
      const chain: any = {};
      let isUpdate = false;
      let payload: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit']) chain[m] = () => chain;
      chain.update = (p: Record<string, unknown>) => ((isUpdate = true), (payload = p), chain);
      chain.then = (resolve: (v: unknown) => void) => {
        if (isUpdate) {
          updates.push(payload);
          return resolve({ data: null, error: updateError });
        }
        resolve({ data: state ? [state] : [], error: null });
      };
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (afterRpcStatus && state) state = { ...state, status: afterRpcStatus };
      return rpcResult;
    },
  } as never;
}

const input = { accountId: 'ACC', campaignId: 'CAMP' };
const base = (status: string, over: Partial<State> = {}): State => ({ id: 'CAMP', status, pausa_automatica_motivo: null, mensagens: [{ tipo: 'texto', conteudo: 'oi' }], ...over });

beforeEach(() => {
  state = base('em_execucao');
  rpcResult = { data: true, error: null };
  rpcCalls = [];
  updates = [];
  updateError = null;
  afterRpcStatus = null;
  approved.mockResolvedValue(true);
});

describe('pauseCampaign', () => {
  it('pausa uma campanha em execução, chama a RPC de pausa e grava o motivo', async () => {
    const r = await pauseCampaign(makeDb(), { ...input, reason: '  conferir carteira ' });
    expect(r).toEqual({ ok: true, changed: true, previous: 'em_execucao', status: 'pausada', itemsPendingMove: false });
    expect(rpcCalls).toEqual([{ fn: 'stop_dispatch_campaign', args: { p_campaign_id: 'CAMP', p_account_id: 'ACC', p_action: 'pause' } }]);
    expect(updates).toEqual([{ pause_reason: 'conferir carteira' }]);
  });
  it('já pausada = sucesso sem chamar a RPC (idempotente)', async () => {
    state = base('pausada');
    expect(await pauseCampaign(makeDb(), input)).toMatchObject({ ok: true, changed: false, status: 'pausada' });
    expect(rpcCalls).toHaveLength(0);
  });
  it('estado incompatível = conflito com o estado atual; campanha inexistente = not_found', async () => {
    state = base('encerrada');
    expect(await pauseCampaign(makeDb(), input)).toMatchObject({ ok: false, kind: 'conflict', details: { status: 'encerrada' } });
    state = base('preparando');
    expect(await pauseCampaign(makeDb(), input)).toMatchObject({ ok: false, kind: 'conflict' });
    state = null;
    expect(await pauseCampaign(makeDb(), input)).toMatchObject({ ok: false, kind: 'not_found' });
  });
  it('corrida: a RPC recusa mas outra chamada já pausou → sucesso sem mudança; se encerraram → conflito', async () => {
    rpcResult = { data: false, error: null };
    afterRpcStatus = 'pausada';
    expect(await pauseCampaign(makeDb(), input)).toMatchObject({ ok: true, changed: false });
    state = base('em_execucao');
    afterRpcStatus = 'encerrada';
    expect(await pauseCampaign(makeDb(), input)).toMatchObject({ ok: false, kind: 'conflict', details: { status: 'encerrada' } });
  });
  it('erro da RPC = internal; coluna pause_reason ausente (357 não aplicada) não derruba a pausa', async () => {
    rpcResult = { data: null, error: { message: 'boom' } };
    expect(await pauseCampaign(makeDb(), input)).toMatchObject({ ok: false, kind: 'internal' });
    rpcResult = { data: true, error: null };
    updateError = { code: '42703', message: 'column "pause_reason" does not exist' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await pauseCampaign(makeDb(), { ...input, reason: 'x' })).toMatchObject({ ok: true, changed: true });
  });
});

describe('cancelCampaign', () => {
  it('cancela em execução, pausada ou agendada e grava o motivo do encerramento', async () => {
    for (const status of ['em_execucao', 'pausada', 'agendado']) {
      state = base(status);
      rpcCalls = [];
      updates = [];
      const r = await cancelCampaign(makeDb(), { ...input, motive: 'cancelled_api' });
      expect(r).toMatchObject({ ok: true, changed: true, previous: status, status: 'encerrada' });
      expect(rpcCalls[0].args.p_action).toBe('stop');
      expect(updates).toEqual([{ encerramento_motivo: 'cancelled_api' }]);
    }
  });
  it('já encerrada = sucesso sem mudança; rascunho/preparando = conflito (a RPC aceitaria, a API não)', async () => {
    state = base('encerrada');
    expect(await cancelCampaign(makeDb(), { ...input, motive: 'cancelled_api' })).toMatchObject({ ok: true, changed: false });
    expect(rpcCalls).toHaveLength(0);
    for (const status of ['rascunho', 'preparando']) {
      state = base(status);
      expect(await cancelCampaign(makeDb(), { ...input, motive: 'cancelled_api' })).toMatchObject({ ok: false, kind: 'conflict', details: { status } });
    }
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('resumeCampaign', () => {
  const start = vi.fn();
  beforeEach(() => {
    start.mockReset();
    start.mockResolvedValue({ ok: true });
    state = base('pausada');
  });

  it('retoma uma pausada, limpa o motivo da pausa e chama startCampaign', async () => {
    const r = await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: false }, start);
    expect(r).toMatchObject({ ok: true, changed: true, previous: 'pausada', status: 'em_execucao' });
    expect(start).toHaveBeenCalledWith('CAMP', 'ACC');
    expect(updates).toEqual([{ pause_reason: null }]);
  });
  it('já em execução = sucesso sem chamar nada; encerrada/rascunho = conflito', async () => {
    state = base('em_execucao');
    expect(await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: false }, start)).toMatchObject({ ok: true, changed: false });
    state = base('encerrada');
    expect(await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: false }, start)).toMatchObject({ ok: false, kind: 'conflict' });
    expect(start).not.toHaveBeenCalled();
  });
  it('pausada pelo motor exige acknowledge_auto_pause', async () => {
    state = base('pausada', { pausa_automatica_motivo: 'Taxa de erro acima do limite' });
    const blocked = await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: false }, start);
    expect(blocked).toMatchObject({ ok: false, kind: 'conflict', details: { code: 'auto_paused', reason: 'Taxa de erro acima do limite' } });
    expect(start).not.toHaveBeenCalled();
    expect(await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: true }, start)).toMatchObject({ ok: true, changed: true });
  });
  it('template não aprovado bloqueia sempre, mesmo com acknowledge', async () => {
    state = base('pausada', { mensagens: [{ tipo: 'texto', template_name: 'promo', template_language: 'pt_BR' }] });
    approved.mockResolvedValue(false);
    const r = await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: true }, start);
    expect(r).toMatchObject({ ok: false, kind: 'blocked', details: { code: 'template_not_approved' } });
    expect(start).not.toHaveBeenCalled();
  });
  it('número em qualidade vermelha (startCampaign devolve code) bloqueia, sem confirmação possível pela API', async () => {
    start.mockResolvedValue({ ok: false, status: 403, error: 'Número com qualidade vermelha', code: 'red_quality_owner_required', channels: [{ id: 'c1' }] });
    const r = await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: false }, start);
    expect(r).toMatchObject({ ok: false, kind: 'blocked', details: { code: 'red_quality', channels: [{ id: 'c1' }] } });
    expect(start).toHaveBeenCalledWith('CAMP', 'ACC'); // nunca recebe redConfirmation
  });
  it('409 do startCampaign vira conflito; outras falhas viram internal', async () => {
    start.mockResolvedValue({ ok: false, status: 409, error: 'Estado da campanha mudou' });
    expect(await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: false }, start)).toMatchObject({ ok: false, kind: 'conflict' });
    start.mockResolvedValue({ ok: false, status: 500, error: 'x' });
    expect(await resumeCampaign(makeDb(), { ...input, acknowledgeAutoPause: false }, start)).toMatchObject({ ok: false, kind: 'internal' });
  });
});
