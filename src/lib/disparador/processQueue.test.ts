import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimed: true,
  confirmationError: null as null | { message: string },
  updates: [] as Array<Record<string, unknown>>,
  tables: [] as string[],
  rpc: vi.fn(),
  send: vi.fn(),
  autoBlacklist: vi.fn(),
  ai: vi.fn(),
}));
vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      mocks.tables.push(table);
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
vi.mock('@/lib/whatsapp/encryption', () => ({
  decryptStoredSecret: (value: string) =>
    value === 'legacy-plaintext-token' ? value : 'test-token',
}));
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
vi.mock('@/lib/disparador/dispatch-ai', () => ({ generateDispatchAiText: mocks.ai }));
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { PreSendError, isDefinitiveRejection, processQueueItem, type QueueItem } from './processQueue';
import { UNCERTAIN_OUTCOME_ERROR } from './provider-outcome';

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
    mocks.autoBlacklist
      .mockReset()
      .mockResolvedValue({ campaignCount: 1, blacklisted: false });
    mocks.rpc.mockReset().mockImplementation(async (name: string) => ({
      data: name === 'claim_dispatch_item' ? mocks.claimed : null,
      error: name === 'confirm_dispatch_item_sent' || name === 'mark_queue_item_sent' ? mocks.confirmationError : null,
    }));
  });
  it('contato do CRM sem telefone NUNCA usa o texto da mensagem como número (REVISAO A1)', async () => {
    const contactItem: QueueItem = {
      ...item,
      contact_id: 'contact',
      mensagem_final: 'Seu debito de R$ 1.234,56 vence 10/10',
      contacts: { phone: '' },
    };
    const result = await processQueueItem(contactItem, { id: 'campaign', status: 'em_execucao' });
    expect(result).toMatchObject({ outcome: 'error', error: 'Contato sem telefone válido' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.updates.some((u) => u.status === 'erro' && u.erro_permanente === true)).toBe(true);
  });
  it('item externo (API v1, contact_id nulo) continua usando mensagem_final como telefone', async () => {
    const result = await processQueueItem(item, { id: 'campaign', status: 'em_execucao' });
    expect(result).toMatchObject({ outcome: 'sent' });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: '5511999999999' }));
  });
  it('falha de CONEXÃO (ECONNREFUSED/ENOTFOUND/EAI_AGAIN/connect timeout): a mensagem não saiu → transitório com retry (P0-3)', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      mocks.updates.length = 0;
      mocks.send.mockReset().mockRejectedValue(new TypeError('fetch failed', { cause: { code } }));
      const result = await processQueueItem(item, { id: 'campaign', status: 'em_execucao' });
      expect(result).toMatchObject({ outcome: 'error', error: expect.stringMatching(/não saiu/) });
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.updates.some((u) => u.status === 'erro' && u.erro_permanente === false && u.tentativas === 1)).toBe(true);
      expect(mocks.updates.some((u) => u.erro_permanente === true)).toBe(false);
    }
  });
  it('502/503/504 da Meta e timeout de resposta: INCERTO — terminal, sem reenvio e com a mensagem que o auto-pause conta', async () => {
    const uncertain = [
      new MetaApiError('Bad Gateway', null, 502),
      new MetaApiError('Service Unavailable', null, 503),
      new MetaApiError('Gateway Timeout', null, 504),
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    ];
    for (const err of uncertain) {
      mocks.updates.length = 0;
      mocks.send.mockReset().mockRejectedValue(err);
      const result = await processQueueItem(item, { id: 'campaign', status: 'em_execucao' });
      expect(result).toMatchObject({ outcome: 'error', error: UNCERTAIN_OUTCOME_ERROR });
      expect(mocks.send).toHaveBeenCalledTimes(1); // at-most-once
      expect(mocks.updates.some((u) => u.status === 'erro' && u.erro_permanente === true && u.erro === UNCERTAIN_OUTCOME_ERROR)).toBe(true);
    }
  });
  it('tipo=ia: IA falhou → NADA é enviado (nunca o prompt), item volta como erro retentável sem consumir tentativa (P0-2)', async () => {
    mocks.ai.mockReset().mockResolvedValue(null);
    const iaItem: QueueItem = { ...item, tipo: 'ia', mensagem_final: 'PROMPT: gere uma cobrança para o cliente', tentativas: 2 };
    const result = await processQueueItem(iaItem, { id: 'campaign', status: 'em_execucao' });
    expect(result).toEqual({ outcome: 'deferred', reason: 'ai_unavailable' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.updates.some((u) => u.status === 'erro' && u.erro_permanente === false && u.tentativas === 2 && /IA indisponível/.test(String(u.erro)))).toBe(true);
    expect(mocks.updates.some((u) => u.erro_permanente === true)).toBe(false);
  });
  it('tipo=ia: IA ok → envia o texto GERADO, não o prompt', async () => {
    mocks.ai.mockReset().mockResolvedValue('Olá! Seu débito vence hoje.');
    const iaItem: QueueItem = { ...item, tipo: 'ia', mensagem_final: 'PROMPT: gere uma cobrança' };
    expect(await processQueueItem(iaItem, { id: 'campaign', status: 'em_execucao' })).toMatchObject({ outcome: 'sent' });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Olá! Seu débito vence hoje.' }));
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

  it('aceita segredo legado em texto puro antes de chamar o provedor', async () => {
    const result = await processQueueItem(
      item,
      { id: 'campaign', status: 'em_execucao' },
      {
        channelConfig: {
          provider: 'meta',
          access_token: 'legacy-plaintext-token',
          phone_number_id: 'phone-id',
        },
        blacklistLookup: () => false,
      }
    );

    expect(result).toMatchObject({ outcome: 'sent' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('keeps the 1st/2nd Meta 131026 out of the definitive blacklist', async () => {
    mocks.send.mockRejectedValue(
      new MetaApiError('Meta: Message undeliverable (code 131026)', 131026, 400)
    );
    mocks.autoBlacklist.mockResolvedValue({ campaignCount: 2, blacklisted: false });

    expect(
      await processQueueItem(item, { id: 'campaign', status: 'em_execucao' })
    ).toMatchObject({ outcome: 'error' });

    expect(mocks.autoBlacklist).toHaveBeenCalledTimes(1);
    expect(
      mocks.updates.some(
        (update) =>
          update.status === 'erro' &&
          update.erro_permanente === true &&
          update.tentativas === 1
      )
    ).toBe(true);
    expect(mocks.updates.some((update) => update.status === 'bloqueado')).toBe(false);
    expect(
      mocks.rpc.mock.calls.some(
        ([name, args]) =>
          name === 'increment_campaign_metric' &&
          args?.p_field === 'total_blacklist'
      )
    ).toBe(false);
  });

  it('blacklists Meta 131026 only on the 3rd distinct campaign', async () => {
    mocks.send.mockRejectedValue(
      new MetaApiError('Meta: Message undeliverable (code 131026)', 131026, 400)
    );
    mocks.autoBlacklist.mockResolvedValue({ campaignCount: 3, blacklisted: true });

    expect(
      await processQueueItem(item, { id: 'campaign', status: 'em_execucao' })
    ).toEqual({ outcome: 'blocked', reason: 'meta_131026_threshold' });

    expect(
      mocks.updates.some(
        (update) =>
          update.status === 'bloqueado' &&
          update.erro_permanente === true &&
          update.tentativas === 1
      )
    ).toBe(true);
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
  it('terminaliza resultado de transporte desconhecido sem reenviar nem prender a vaga', async () => {
    mocks.send.mockRejectedValue(new TypeError('connection lost after POST'));
    expect(
      await processQueueItem(item, { id: 'campaign', status: 'em_execucao' })
    ).toMatchObject({
      outcome: 'error',
      error: expect.stringMatching(/sem reenvio/),
    });
    expect(
      mocks.updates.some(
        (update) => update.status === 'erro' && update.erro_permanente === true
      )
    ).toBe(true);
    expect(
      mocks.rpc.mock.calls.some(([name]) => name === 'mark_queue_item_sent' || name === 'confirm_dispatch_item_sent')
    ).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(1);
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

describe('janela de envio: sem rajada na reabertura (relógio de janela)', () => {
  // Horário de Brasília → instante UTC. 15/10/2026 = quinta.
  const br = (day: number, hh: number, mm = 0, ss = 0) => new Date(Date.UTC(2026, 9, day, hh + 3, mm, ss));
  const batched = {
    id: 'campaign',
    status: 'em_execucao',
    janela_inicio: '08:00',
    janela_fim: '18:00',
    batch_size: 50,
  };
  beforeEach(() => {
    mocks.updates.length = 0;
    mocks.send.mockReset().mockResolvedValue({ messageId: 'wamid.test' });
    mocks.rpc.mockReset().mockImplementation(async (name: string) => ({
      data: name === 'claim_dispatch_item' ? true : null,
      error: null,
    }));
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fora da janela: último recurso adia para a próxima abertura (sem empurrar por dias)', async () => {
    vi.setSystemTime(br(15, 20));
    const res = await processQueueItem({ ...item, scheduled_at: br(15, 18, 45).toISOString() }, batched);
    expect(res).toEqual({ outcome: 'deferred', reason: 'outside_window' });
    expect(mocks.updates).toEqual([{ status: 'agendado', scheduled_at: br(16, 8).toISOString() }]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('janela aberta: não há mais adiamento item a item (o cron redistribui a fila antes)', async () => {
    // Antes (#75) um item de segunda 07:45 numa fila antiga ia para a
    // terça da semana seguinte. A redistribuição agora é do cron
    // (queue-reflow.ts); aqui o item só é enviado.
    vi.setSystemTime(br(19, 8, 0, 30));
    const res = await processQueueItem({ ...item, scheduled_at: br(19, 7, 45).toISOString() }, {
      ...batched,
      dias_envio: [1, 2, 3, 4, 5],
    });
    expect(res).toMatchObject({ outcome: 'sent' });
    expect(mocks.updates.some((u) => 'scheduled_at' in u)).toBe(false);
  });

  it('janela aberta: item agendado em horário aberto sai normalmente', async () => {
    vi.setSystemTime(br(16, 9));
    const res = await processQueueItem({ ...item, scheduled_at: br(16, 8, 45).toISOString() }, batched);
    expect(res).toMatchObject({ outcome: 'sent' });
  });

  it('modo sequencial (batch_size 1) não muda: envia o item vencido à noite', async () => {
    vi.setSystemTime(br(16, 8, 0, 30));
    const res = await processQueueItem(
      { ...item, scheduled_at: br(15, 18, 45).toISOString() },
      { ...batched, batch_size: 1 }
    );
    expect(res).toMatchObject({ outcome: 'sent' });
  });
});

describe('opções do agendador do cron', () => {
  const campaign = { id: 'campaign', status: 'em_execucao' };
  beforeEach(() => {
    mocks.updates.length = 0;
    mocks.send.mockReset().mockResolvedValue({ messageId: 'wamid.test' });
    mocks.rpc.mockReset().mockImplementation(async (name: string) => ({
      data: name.startsWith('claim_dispatch_item') ? true : null,
      error: null,
    }));
  });

  it('sem opções (ou padrão 4) usa o claim_dispatch_item de sempre', async () => {
    await processQueueItem(item, campaign);
    await processQueueItem(item, campaign, { defaultMaxInFlight: 4 });
    const claims = mocks.rpc.mock.calls.filter(([name]) => String(name).startsWith('claim'));
    expect(claims.map(([name]) => name)).toEqual(['claim_dispatch_item', 'claim_dispatch_item']);
  });

  it('padrão por número diferente de 4 usa o claim com teto do app', async () => {
    await processQueueItem(item, campaign, { defaultMaxInFlight: 8 });
    expect(mocks.rpc).toHaveBeenCalledWith('claim_dispatch_item_capped', {
      p_item_id: 'item',
      p_default_max_in_flight: 8,
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('claim_dispatch_item', expect.anything());
  });

  it('observa latência e sinal do provedor sem mudar o resultado', async () => {
    const observations: unknown[] = [];
    const ok = await processQueueItem(item, campaign, { onProviderCall: (o) => observations.push(o) });
    expect(ok).toMatchObject({ outcome: 'sent' });
    mocks.send.mockRejectedValueOnce(new MetaApiError('pair rate limit', 131056, 400));
    const limited = await processQueueItem(item, campaign, {
      onProviderCall: (o) => {
        observations.push(o);
        throw new Error('observador quebrado não afeta o envio');
      },
    });
    expect(limited).toMatchObject({ outcome: 'error' });
    expect(observations).toEqual([
      expect.objectContaining({ provider: 'meta', ok: true, signal: null, code: null }),
      expect.objectContaining({ provider: 'meta', ok: false, signal: 'rate_limit', code: 'meta:131056' }),
    ]);
  });

  it('canal e blacklist do tick: sem select por envio', async () => {
    mocks.tables.length = 0;
    const lookup = vi.fn(() => false);
    const channelConfig = { provider: 'meta', access_token: 'encrypted', phone_number_id: 'phone-id' };
    expect(await processQueueItem(item, campaign, { channelConfig, blacklistLookup: lookup })).toMatchObject({
      outcome: 'sent',
    });
    expect(lookup).toHaveBeenCalledWith('5511999999999');
    expect(mocks.tables).not.toContain('whatsapp_config');
    expect(mocks.tables).not.toContain('blacklist');
  });

  it('blacklist do tick bloqueia sem chamar o provedor', async () => {
    const result = await processQueueItem(item, campaign, { channelConfig: {}, blacklistLookup: () => true });
    expect(result).toEqual({ outcome: 'blocked', reason: 'blacklisted' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.updates).toContainEqual({ status: 'bloqueado', erro: 'Número na Blacklist' });
  });

  it('telefone fora do tick (lookup undefined) e canal não carregado: consulta como antes', async () => {
    mocks.tables.length = 0;
    expect(
      await processQueueItem(item, campaign, { channelConfig: undefined, blacklistLookup: () => undefined })
    ).toMatchObject({ outcome: 'sent' });
    expect(mocks.tables).toContain('blacklist');
    expect(mocks.tables).toContain('whatsapp_config');
  });

  it('canal null (outra conta) fecha como erro permanente sem enviar', async () => {
    const result = await processQueueItem(item, campaign, { channelConfig: null, blacklistLookup: () => false });
    expect(result).toMatchObject({ outcome: 'error' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.updates.some((u) => u.status === 'erro' && u.erro_permanente === true)).toBe(true);
  });

  it('confirmação com replay numa RPC (migration 167): sem replay à parte', async () => {
    expect(await processQueueItem(item, campaign)).toMatchObject({ outcome: 'sent' });
    const names = mocks.rpc.mock.calls.map(([name]) => name);
    expect(names).toContain('confirm_dispatch_item_sent');
    expect(names).not.toContain('mark_queue_item_sent');
    expect(names).not.toContain('replay_dispatch_receipts');
  });

  // Por último: os fallbacks desligam as RPCs novas no processo.
  it('sem a migration 167, confirma com mark_queue_item_sent + replay', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'confirm_dispatch_item_sent')
        return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      return { data: name.startsWith('claim_dispatch_item') ? true : null, error: null };
    });
    expect(await processQueueItem(item, campaign)).toMatchObject({ outcome: 'sent' });
    const names = mocks.rpc.mock.calls.map(([name]) => name);
    expect(names).toEqual(['claim_dispatch_item', 'confirm_dispatch_item_sent', 'mark_queue_item_sent', 'replay_dispatch_receipts']);
    mocks.rpc.mockClear();
    await processQueueItem(item, campaign);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      'claim_dispatch_item', 'mark_queue_item_sent', 'replay_dispatch_receipts',
    ]);
  });

  it('sem a migration 164, cai no claim_dispatch_item', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'claim_dispatch_item_capped')
        return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      return { data: name === 'claim_dispatch_item' ? true : null, error: null };
    });
    expect(await processQueueItem(item, campaign, { defaultMaxInFlight: 8 })).toMatchObject({ outcome: 'sent' });
    expect(mocks.rpc).toHaveBeenCalledWith('claim_dispatch_item', { p_item_id: 'item' });
  });
});
