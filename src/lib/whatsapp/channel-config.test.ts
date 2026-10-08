import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ adminCalls: [] as Array<Array<unknown>>, adminResult: { data: [] as unknown, error: null as unknown } }))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    const proxy: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in']) {
      proxy[m] = (...args: unknown[]) => {
        mocks.adminCalls.push([m, ...args])
        return proxy
      }
    }
    proxy.from = (t: string) => {
      mocks.adminCalls.push(['from', t])
      return proxy
    }
    proxy.then = (resolve: (v: unknown) => unknown) => resolve(mocks.adminResult)
    return proxy
  },
}))

import { fetchChannelConfig, fetchChannelConfigs } from './channel-config'

/** Cliente de sessão falso: grava as chamadas e devolve o que a RLS "deixaria ver". */
function session(visible: { data: unknown; error: unknown }) {
  const calls: Array<Array<unknown>> = []
  const proxy: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
    proxy[m] = (...args: unknown[]) => {
      calls.push([m, ...args])
      return proxy
    }
  }
  proxy.from = (t: string) => {
    calls.push(['from', t])
    return proxy
  }
  proxy.then = (resolve: (v: unknown) => unknown) => resolve(visible)
  return { client: proxy as never, calls }
}

const ACC = 'acc-1'

beforeEach(() => {
  mocks.adminCalls.length = 0
  mocks.adminResult = { data: [], error: null }
})

describe('fetchChannelConfigs (migration 200b)', () => {
  it('etapa 1 usa o cliente de sessão só com `id` (colunas não secretas) e os filtros da rota', async () => {
    const s = session({ data: [{ id: 'c1' }], error: null })
    mocks.adminResult = { data: [{ id: 'c1', access_token: 'cifrado' }], error: null }
    await fetchChannelConfigs(s.client, ACC, (q) => q.eq('account_id', ACC).eq('provider', 'waha'))
    expect(s.calls).toEqual([['from', 'whatsapp_config'], ['select', 'id'], ['eq', 'account_id', ACC], ['eq', 'provider', 'waha']])
  })

  it('etapa 2 lê os segredos pelo service role SEMPRE escopado por conta e pelos ids visíveis', async () => {
    const s = session({ data: [{ id: 'c1' }, { id: 'c2' }], error: null })
    mocks.adminResult = { data: [{ id: 'c1', access_token: 'a' }, { id: 'c2', access_token: 'b' }], error: null }
    const res = await fetchChannelConfigs(s.client, ACC, (q) => q, 'id, access_token')
    expect(mocks.adminCalls).toEqual([['from', 'whatsapp_config'], ['select', 'id, access_token'], ['eq', 'account_id', ACC], ['in', 'id', ['c1', 'c2']]])
    expect(res.data).toHaveLength(2)
  })

  it('canal que a RLS não deixa o usuário ver (outra equipe) nunca é lido com segredo', async () => {
    const s = session({ data: [], error: null })
    const res = await fetchChannelConfigs(s.client, ACC, (q) => q.eq('id', 'canal-de-outra-equipe'))
    expect(res).toEqual({ data: [], error: null })
    expect(mocks.adminCalls).toHaveLength(0) // service role nem é chamado
  })

  it('só devolve linhas da conta mesmo que o service role devolvesse mais (defesa em profundidade)', async () => {
    const s = session({ data: [{ id: 'c1' }], error: null })
    mocks.adminResult = { data: [{ id: 'c1', account_id: ACC }, { id: 'c9', account_id: 'outra' }], error: null }
    const res = await fetchChannelConfigs<{ id: string }>(s.client, ACC)
    expect(res.data?.map((r) => r.id)).toEqual(['c1'])
  })

  it('preserva a ordem pedida na etapa 1 (.order) mesmo que o service role devolva embaralhado', async () => {
    const s = session({ data: [{ id: 'c2' }, { id: 'c1' }, { id: 'c3' }], error: null })
    mocks.adminResult = { data: [{ id: 'c1' }, { id: 'c3' }, { id: 'c2' }], error: null }
    const res = await fetchChannelConfigs<{ id: string }>(s.client, ACC, (q) => q.order('created_at', { ascending: true }))
    expect(res.data?.map((r) => r.id)).toEqual(['c2', 'c1', 'c3'])
  })

  it('erro de qualquer etapa é propagado (sem dados)', async () => {
    const e1 = await fetchChannelConfigs(session({ data: null, error: { message: 'rls' } }).client, ACC)
    expect(e1).toEqual({ data: null, error: { message: 'rls' } })
    mocks.adminResult = { data: null, error: { message: 'boom' } }
    const e2 = await fetchChannelConfigs(session({ data: [{ id: 'c1' }], error: null }).client, ACC)
    expect(e2).toEqual({ data: null, error: { message: 'boom' } })
  })
})

describe('fetchChannelConfig', () => {
  it('equivale a .limit(1): pede 1 linha na etapa 1 e devolve a primeira', async () => {
    const s = session({ data: [{ id: 'c1' }], error: null })
    mocks.adminResult = { data: [{ id: 'c1', provider: 'meta' }], error: null }
    const res = await fetchChannelConfig<{ id: string; provider: string }>(s.client, ACC, (q) => q.eq('habilitado', true))
    expect(s.calls).toContainEqual(['limit', 1])
    expect(res.data).toEqual({ id: 'c1', provider: 'meta' })
  })
  it('sem linha visível devolve null', async () => {
    const res = await fetchChannelConfig(session({ data: [], error: null }).client, ACC)
    expect(res.data).toBeNull()
  })
})

// Marca de uso para o vitest não reclamar de import não usado quando o mock é só de estrutura.
void vi
