import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALL_PERMISSION_REQUIRED_BODY,
  callStatusOf,
  extractCallEvents,
  hasCallPermission,
  parseCallPermissionReply,
  processCallEvents,
  recordCallPermissionReply,
  type CallsValue,
} from './calls'

afterEach(() => vi.restoreAllMocks())

const value = (calls: unknown[], statuses: unknown[] = []): CallsValue =>
  ({ metadata: { phone_number_id: '111' }, contacts: [{ wa_id: '5511999990001', profile: { name: 'Fulano' } }], calls, statuses }) as CallsValue

describe('callStatusOf — nomes da Meta e do PRD', () => {
  it.each([
    ['connect', undefined, 'ringing'], ['connect_request', undefined, 'ringing'], ['ringing', undefined, 'ringing'],
    ['connected', undefined, 'connected'], ['accepted', undefined, 'connected'],
    ['terminate', 'COMPLETED', 'ended'], ['terminate', undefined, 'ended'], ['ended', undefined, 'ended'],
    ['terminate', 'FAILED', 'failed'], ['terminate', 'REJECTED', 'rejected'], ['rejected', undefined, 'rejected'], ['missed', undefined, 'missed'],
    [undefined, 'RINGING', 'ringing'], [undefined, 'ACCEPTED', 'connected'], [undefined, 'REJECTED', 'rejected'],
  ])('%s / %s ⇒ %s', (event, status, expected) => {
    expect(callStatusOf(event, status)).toBe(expected)
  })
  it('desconhecido ⇒ null', () => {
    expect(callStatusOf('pre_accept', undefined)).toBeNull()
    expect(callStatusOf(undefined, 'whatever')).toBeNull()
  })
})

describe('extractCallEvents', () => {
  it('chamada recebida: telefone do cliente = from; chamada do negócio: to', () => {
    const [a, b] = extractCallEvents(
      value([
        { id: 'wacid.1', from: '5511999990001', to: '551133334444', event: 'connect', direction: 'USER_INITIATED', timestamp: '1760000000' },
        { id: 'wacid.2', from: '551133334444', to: '+55 (11) 98888-7777', event: 'terminate', direction: 'BUSINESS_INITIATED', timestamp: '1760000100', start_time: '1760000010', end_time: '1760000100', duration: '90', status: 'COMPLETED' },
      ]),
    )
    expect(a).toMatchObject({ metaCallId: 'wacid.1', direction: 'inbound', status: 'ringing', phone: '5511999990001', eventTs: 1760000000, canCreate: true })
    expect(b).toMatchObject({ metaCallId: 'wacid.2', direction: 'outbound', status: 'ended', phone: '5511988887777', startTs: 1760000010, endTs: 1760000100, duration: 90 })
  })

  it('erro da Meta vira causa; status avulso não pode criar a chamada', () => {
    const ev = extractCallEvents(
      value(
        [{ id: 'w', to: '5511999990001', event: 'terminate', direction: 'BUSINESS_INITIATED', status: 'FAILED', errors: [{ code: 131053, message: 'call_permission_required' }] }],
        [{ id: 'w2', status: 'ACCEPTED', timestamp: '1760000050', recipient_id: '5511999990001' }],
      ),
    )
    expect(ev[0]).toMatchObject({ status: 'failed', cause: '131053: call_permission_required' })
    expect(ev[1]).toMatchObject({ metaCallId: 'w2', status: 'connected', canCreate: false, direction: null })
  })

  it('ignora o que não dá para acompanhar (sem id, evento desconhecido)', () => {
    expect(extractCallEvents(value([{ event: 'connect' }, { id: 'x', event: 'pre_accept' }, null as never], [{ id: 'y', status: 'zzz' }]))).toEqual([])
    expect(extractCallEvents(null)).toEqual([])
  })
})

describe('processCallEvents', () => {
  const ctx = { contactId: 'ct-1', conversationId: 'cv-1' }

  function mk(rpcImpl?: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { code?: string; message?: string } | null }) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const resolveContext = vi.fn(async (_phone: string, _name: string): Promise<typeof ctx | null> => ctx)
    const db = {
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        calls.push({ fn, args: args ?? {} })
        return rpcImpl ? rpcImpl(fn, args ?? {}) : { data: fn === 'apply_call_event' ? { result: 'created' } : true, error: null }
      },
    }
    return { calls, resolveContext, deps: { db, accountId: 'acc-1', channelId: 'ch-1', resolveContext, now: () => 1_760_000_000_000 } }
  }

  it('aplica o evento com conta/canal do canal VERIFICADO e resolve contato/conversa para a chamada nova', async () => {
    const { calls, resolveContext, deps } = mk()
    const s = await processCallEvents(value([{ id: 'wacid.1', from: '5511999990001', event: 'connect', direction: 'USER_INITIATED', timestamp: '1760000000' }]), deps)
    expect(s).toMatchObject({ applied: 1, failed: 0, missing: false })
    expect(resolveContext).toHaveBeenCalledWith('5511999990001', 'Fulano')
    expect(calls[0]).toMatchObject({ fn: 'apply_call_event', args: { p_account_id: 'acc-1', p_channel_id: 'ch-1', p_conversation_id: 'cv-1', p_contact_id: 'ct-1', p_meta_call_id: 'wacid.1', p_direction: 'inbound', p_status: 'ringing' } })
  })

  it('cliente que LIGA abre a janela de retorno de 72 h (permissão inbound_call)', async () => {
    const { calls, deps } = mk()
    await processCallEvents(value([{ id: 'wacid.1', from: '5511999990001', event: 'connect', direction: 'USER_INITIATED', timestamp: '1760000000' }]), deps)
    const perm = calls.find((c) => c.fn === 'record_call_permission')!
    expect(perm.args).toMatchObject({ p_account_id: 'acc-1', p_contact_id: 'ct-1', p_phone: '5511999990001', p_source: 'inbound_call' })
    expect(Date.parse(String(perm.args.p_expires_at)) - Date.parse(String(perm.args.p_granted_at))).toBe(72 * 3_600_000)
  })

  it('chamada do negócio e status avulso NÃO concedem permissão; status avulso não resolve/cria contato', async () => {
    const { calls, resolveContext, deps } = mk()
    await processCallEvents(value([{ id: 'w', to: '5511999990001', event: 'connect', direction: 'BUSINESS_INITIATED' }], [{ id: 'w', status: 'RINGING' }]), deps)
    expect(calls.some((c) => c.fn === 'record_call_permission')).toBe(false)
    expect(resolveContext).toHaveBeenCalledTimes(1)
    expect(calls[1].args).toMatchObject({ p_conversation_id: null, p_contact_id: null })
  })

  it('migration 250 ausente: ignora (missing) sem lançar e sem insistir nos demais eventos', async () => {
    const { calls, deps } = mk(() => ({ data: null, error: { code: 'PGRST202', message: 'x' } }))
    const s = await processCallEvents(
      value([{ id: 'a', from: '5511999990001', event: 'connect', direction: 'USER_INITIATED' }, { id: 'b', from: '5511999990001', event: 'connect', direction: 'USER_INITIATED' }]),
      deps,
    )
    expect(s.missing).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('erro de um evento não impede os outros; exceção nunca vaza', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    const { deps } = mk(() => {
      n++
      if (n === 1) throw new Error('rede')
      return { data: { result: 'updated' }, error: null }
    })
    const s = await processCallEvents(
      value([{ id: 'a', from: '5511999990001', event: 'connect', direction: 'USER_INITIATED' }, { id: 'b', from: '5511999990001', event: 'connected', direction: 'USER_INITIATED' }]),
      deps,
    )
    expect(s).toMatchObject({ failed: 1 })
    expect(s.applied).toBe(1)
    expect(log).toHaveBeenCalled()
  })

  it('contato não resolvido: o evento da lista `calls` é só ignorado pelo banco (sem conversa não cria)', async () => {
    const { calls, deps } = mk(() => ({ data: { result: 'unknown_call' }, error: null }))
    deps.resolveContext = vi.fn(async () => null)
    const s = await processCallEvents(value([{ id: 'a', from: '5511999990001', event: 'connect', direction: 'USER_INITIATED' }]), deps)
    expect(s.ignored).toBe(1)
    expect(calls[0].args).toMatchObject({ p_conversation_id: null })
    expect(calls.some((c) => c.fn === 'record_call_permission')).toBe(false)
  })
})

describe('Call Permission', () => {
  it('parseCallPermissionReply: aceitar, recusar, permanente, expiração; outros ⇒ null', () => {
    expect(parseCallPermissionReply({ type: 'call_permission_reply', call_permission_reply: { response: 'accept', is_permanent: true } })).toEqual({ accepted: true, permanent: true, expiresAt: null })
    expect(parseCallPermissionReply({ call_permission_reply: { response: 'accept', expiration_timestamp: 1760500000 } })).toEqual({ accepted: true, permanent: false, expiresAt: 1760500000 })
    expect(parseCallPermissionReply({ call_permission_reply: { response: 'reject' } })).toMatchObject({ accepted: false })
    expect(parseCallPermissionReply({ call_permission_reply: { response: 'talvez' } })).toBeNull()
    expect(parseCallPermissionReply({ button_reply: { id: 'x' } })).toBeNull()
    expect(parseCallPermissionReply(undefined)).toBeNull()
  })

  const base = { accountId: 'acc-1', contactId: 'ct-1', phone: '5511999990001', messageTs: 1_760_000_000, now: () => 1_760_000_100_000 }
  const recorder = () => {
    const calls: Array<Record<string, unknown>> = []
    return { calls, db: { rpc: async (_fn: string, args?: Record<string, unknown>) => (calls.push(args ?? {}), { data: true, error: null }) } }
  }

  it('aceite temporário sem expiração = 7 dias a partir da resposta; com expiração da Meta vale a da Meta; permanente = infinity', async () => {
    const r1 = recorder()
    await recordCallPermissionReply(r1.db, { ...base, reply: { accepted: true, permanent: false, expiresAt: null } })
    expect(Date.parse(String(r1.calls[0].p_expires_at)) - Date.parse(String(r1.calls[0].p_granted_at))).toBe(7 * 86_400_000)
    expect(r1.calls[0]).toMatchObject({ p_source: 'interactive_optin', p_phone: '5511999990001' })
    const r2 = recorder()
    await recordCallPermissionReply(r2.db, { ...base, reply: { accepted: true, permanent: false, expiresAt: 1_760_500_000 } })
    expect(r2.calls[0].p_expires_at).toBe(new Date(1_760_500_000 * 1000).toISOString())
    const r3 = recorder()
    await recordCallPermissionReply(r3.db, { ...base, reply: { accepted: true, permanent: true, expiresAt: null } })
    expect(r3.calls[0].p_expires_at).toBe('infinity')
  })

  it('recusa grava expiração no PASSADO (revoga)', async () => {
    const r = recorder()
    await recordCallPermissionReply(r.db, { ...base, reply: { accepted: false, permanent: false, expiresAt: null } })
    expect(Date.parse(String(r.calls[0].p_expires_at))).toBeLessThan(base.now())
  })

  it('hasCallPermission: true só se o banco confirma; erro/ausência da migration barra (false)', async () => {
    expect(await hasCallPermission({ rpc: async () => ({ data: true, error: null }) }, 'a', '55')).toBe(true)
    expect(await hasCallPermission({ rpc: async () => ({ data: false, error: null }) }, 'a', '55')).toBe(false)
    expect(await hasCallPermission({ rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }, 'a', '55')).toBe(false)
    expect(await hasCallPermission({ rpc: async () => { throw new Error('x') } }, 'a', '55')).toBe(false)
  })

  it('o 412 documentado tem o código call_permission_required', () => {
    expect(CALL_PERMISSION_REQUIRED_BODY.error.code).toBe('call_permission_required')
  })
})
