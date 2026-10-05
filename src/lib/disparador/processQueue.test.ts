import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimed: true,
  confirmationError: null as null | { message: string },
  updates: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  send: vi.fn(),
  autoBlacklist: vi.fn(),
}));
vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const result = {
        data:
          table === 'whatsapp_config'
            ? {
                provider: 'meta',
                access_token: 'encrypted',
                phone_number_id: 'phone-id',
              }
            : null,
        error: null,
      };
      const builder: Record<string, unknown> = {};
      for (const method of [
        'select',
        'eq',
        'in',
        'order',
        'limit',
        'lte',
        'is',
      ])
        builder[method] = () => builder;
      builder.update = (value: Record<string, unknown>) => {
        mocks.updates.push(value);
        return builder;
      };
      builder.maybeSingle = async () => result;
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
      return builder;
    },
  }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'test-token' }));
vi.mock('@/lib/logger', () => ({
  writeLog: vi.fn(),
  maskPhone: () => 'masked',
}));
vi.mock('@/lib/disparador/auto-blacklist', () => ({
  autoBlacklistOn131026: mocks.autoBlacklist,
}));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: mocks.send,
}));
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { PreSendError, isDefinitiveRejection, processQueueItem, type QueueItem } from './processQueue';

const item: QueueItem = {
  id: 'item',
  campaign_id: 'campaign',
  contact_id: null,
  session_id: 'channel',
  tipo: 'texto',
  mensagem_final: '5511999999999',
};

describe('queue provider outcomes', () => {
  beforeEach(() => {
    mocks.claimed = true;
    mocks.confirmationError = null;
    mocks.updates.length = 0;
    mocks.send.mockReset().mockResolvedValue({ messageId: 'wamid.test' });
    mocks.autoBlacklist.mockReset().mockResolvedValue(undefined);
    mocks.rpc.mockReset().mockImplementation(async (name: string) => ({
      data: name === 'claim_dispatch_item' ? mocks.claimed : null,
      error: name === 'mark_queue_item_sent' ? mocks.confirmationError : null,
    }));
  });
  it('never calls the provider after losing the guarded claim', async () => {
    mocks.claimed = false;
    expect(
      await processQueueItem(item, { id: 'campaign', status: 'em_execucao' })
    ).toMatchObject({ outcome: 'deferred' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('confirms an accepted operation using the atomic RPC', async () => {
    expect(
      await processQueueItem(item, { id: 'campaign', status: 'em_execucao' })
    ).toEqual({ outcome: 'sent', messageId: 'wamid.test' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('blocks Meta 131026 permanently instead of scheduling a retry', async () => {
    mocks.send.mockRejectedValue(
      new MetaApiError('Meta: Message undeliverable (code 131026)', 131026, 400)
    );

    expect(
      await processQueueItem(item, { id: 'campaign', status: 'em_execucao' })
    ).toEqual({ outcome: 'blocked', reason: 'meta_131026' });

    expect(mocks.autoBlacklist).toHaveBeenCalledTimes(1);
    expect(
      mocks.updates.some(
        (update) =>
          update.status === 'bloqueado' &&
          update.erro_permanente === true &&
          update.tentativas === 1
      )
    ).toBe(true);
    expect(
      mocks.updates.some(
        (update) => update.status === 'agendado' || update.erro_permanente === false
      )
    ).toBe(false);
    expect(
      mocks.rpc.mock.calls.some(
        ([name, args]) =>
          name === 'increment_campaign_metric' &&
          args?.p_field === 'total_blacklist'
      )
    ).toBe(true);
  });

  it('does not reopen the reservation when local confirmation fails', async () => {
    mocks.confirmationError = { message: 'database unavailable' };
    expect(
      await processQueueItem(item, { id: 'campaign', status: 'em_execucao' })
    ).toMatchObject({
      outcome: 'pending_confirmation',
      messageId: 'wamid.test',
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(
      mocks.updates.some(
        (update) => update.status === 'agendado' || update.status === 'erro'
      )
    ).toBe(false);
  });
  it('quarantines an unknown transport outcome instead of scheduling another POST', async () => {
    mocks.send.mockRejectedValue(new TypeError('connection lost after POST'));
    expect(
      await processQueueItem(item, { id: 'campaign', status: 'em_execucao' })
    ).toMatchObject({
      outcome: 'pending_confirmation',
      reason: 'provider_outcome_unknown',
    });
    expect(
      mocks.updates.some(
        (update) => update.status === 'agendado' || update.status === 'erro'
      )
    ).toBe(false);
    expect(
      mocks.rpc.mock.calls.some(([name]) => name === 'mark_queue_item_sent')
    ).toBe(false);
  });
});

describe('isDefinitiveRejection (item não fica preso em "enviando")', () => {
  it('rejeições explícitas viram erro', () => {
    expect(isDefinitiveRejection(new Error('WAHA sendText failed (404): session not found'))).toBe(true);
    expect(isDefinitiveRejection(new Error('WAHA sendFile failed (422): bad file'))).toBe(true);
    expect(isDefinitiveRejection(new PreSendError('Canal Meta sem token de acesso configurado'))).toBe(true);
    expect(isDefinitiveRejection(new MetaApiError('bad param (code 131008)', 131008, 400))).toBe(true);
    expect(isDefinitiveRejection(new Error('Chamada não atendida (tempo esgotado)'))).toBe(true);
    expect(isDefinitiveRejection(new Error('Failed to start WaCalls call: 404 - x'))).toBe(true);
  });
  it('resultado desconhecido continua aguardando reconciliação', () => {
    expect(isDefinitiveRejection(new TypeError('fetch failed'))).toBe(false);
    expect(isDefinitiveRejection(new Error('WAHA sendText failed (500): oops'))).toBe(false);
    expect(isDefinitiveRejection(new Error('WAHA sendText failed (408): timeout'))).toBe(false);
    expect(isDefinitiveRejection(new MetaApiError('server', null, 503))).toBe(false);
    expect(isDefinitiveRejection(new Error('Não foi possível gerar um CallID para a ligação'))).toBe(false);
  });
});

describe('janela de 24h (131047)', () => {
  beforeEach(() => {
    mocks.claimed = true;
    mocks.updates.length = 0;
    mocks.rpc.mockReset().mockImplementation(async (name: string) => ({
      data: name === 'claim_dispatch_item' ? true : null,
      error: null,
    }));
  });
  it('é erro permanente e não marca o telefone como inválido', async () => {
    mocks.send.mockReset().mockRejectedValue(new MetaApiError('Re-engagement message (code 131047)', 131047, 400));
    const res = await processQueueItem(item, { id: 'campaign', status: 'em_execucao' });
    expect(res).toMatchObject({ outcome: 'error' });
    expect(mocks.updates.some((u) => u.status === 'erro' && u.erro_permanente === true)).toBe(true);
    expect(mocks.updates.some((u) => u.status === 'invalido')).toBe(false);
  });
});
