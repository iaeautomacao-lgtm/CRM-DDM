import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { markProviderCallStarted, releaseUncalledItem, resetProviderCallMarkerState, NOT_CALLED_SENTINEL } from './provider-call-marker'
import { recoverStaleSendingReservations } from './reconcile-unknown-provider-outcomes'
import { beginShutdown, onShutdownAfterSends, resetShutdownGate, trackSend, isShuttingDown, waitForInFlightSends } from './shutdown-gate'

// D-02 (migration 332): restart do Passenger no meio do tick. Uma fila em memória reproduz o que o banco faz (o claim põe o item em
// 'enviando' com o marcador '-infinity', como o trigger da 332) e um "provedor" conta quantas chamadas cada item recebeu.
// A propriedade que importa: NENHUM item recebe duas chamadas, e o que nunca saiu não se perde.

type Row = {
  id: string
  campaign_id: string
  contact_id: string | null
  session_id: string | null
  mensagem_final: string | null
  waha_message_id: string | null
  tentativas: number
  erro: string | null
  erro_permanente?: boolean
  sent_at: string | null
  updated_at: string
  status: string
  inflight_until: string | null
  provider_call_started_at: string | null
}

function fakeQueue(rows: Row[], hooks: { beforeUpdate?: () => void } = {}) {
  const db = {
    from(table: string) {
      if (table !== 'disp_message_queue') throw new Error(`tabela inesperada ${table}`)
      let op: 'select' | 'update' = 'select'
      let values: Partial<Row> = {}
      let returning = false
      let limitN = Infinity
      const filters: Array<(r: Row) => boolean> = []
      const parseOr = (expr: string) => {
        const parts = expr.split(',').map((part) => {
          const m = /^([a-z_]+)\.(is|eq|lt)\.(.+)$/.exec(part)!
          const [, col, kind, val] = m
          return (r: Row) => {
            const v = (r as unknown as Record<string, unknown>)[col] ?? null
            if (kind === 'is') return val === 'null' ? v === null : false
            if (kind === 'eq') return v === val
            return v !== null && String(v) < val
          }
        })
        return (r: Row) => parts.some((f) => f(r))
      }
      const b: Record<string, unknown> = {}
      b.select = () => {
        if (op === 'update') returning = true
        return b
      }
      b.update = (v: Partial<Row>) => ((op = 'update'), (values = v), b)
      b.eq = (c: string, v: unknown) => (filters.push((r) => (r as unknown as Record<string, unknown>)[c] === v), b)
      b.is = (c: string, v: unknown) => (filters.push((r) => ((r as unknown as Record<string, unknown>)[c] ?? null) === v), b)
      b.lt = (c: string, v: string) => (filters.push((r) => String((r as unknown as Record<string, unknown>)[c]) < v), b)
      b.or = (expr: string) => (filters.push(parseOr(expr)), b)
      b.limit = (n: number) => ((limitN = n), b)
      b.then = (resolve: (v: unknown) => void) => {
        if (op === 'update') {
          hooks.beforeUpdate?.()
          const hit = rows.filter((r) => filters.every((f) => f(r)))
          for (const r of hit) Object.assign(r, values)
          return resolve({ data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null })
        }
        return resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN).map((r) => ({ ...r })), error: null })
      }
      return b
    },
    rpc: async () => ({ data: null, error: null }),
  }
  return db as unknown as SupabaseClient
}

const T0 = Date.parse('2026-10-09T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const newRow = (id: string, over: Partial<Row> = {}): Row => ({
  id, campaign_id: 'c1', contact_id: 'ct', session_id: 's1', mensagem_final: 'oi', waha_message_id: null, tentativas: 0, erro: null, sent_at: null,
  updated_at: iso(T0), status: 'agendado', inflight_until: null, provider_call_started_at: null, ...over,
})

/** Claim como o banco faz: 'enviando', lease de 120 s e (trigger da 332) marcador '-infinity'. */
function claim(row: Row, atMs: number) {
  row.status = 'enviando'
  row.inflight_until = iso(atMs + 120_000)
  row.updated_at = iso(atMs)
  row.provider_call_started_at = NOT_CALLED_SENTINEL
}

/** Um remetente completo: marca, chama o provedor (contado), e confirma — com pontos de queda. */
function makeProvider() {
  const calls = new Map<string, number>()
  return {
    calls,
    count: (id: string) => calls.get(id) ?? 0,
    async send(db: SupabaseClient, row: Row, opts: { crashAfterMark?: boolean; crashAfterCall?: boolean } = {}): Promise<'sent' | 'lost' | 'crash'> {
      const mark = await markProviderCallStarted(db, row.id)
      if (mark !== 'marked') return 'lost'
      if (opts.crashAfterMark) return 'crash' // morreu depois de marcar e antes do POST? (o POST não saiu, mas o marcador diz "pode ter saído")
      calls.set(row.id, (calls.get(row.id) ?? 0) + 1)
      if (opts.crashAfterCall) return 'crash' // POST saiu, confirmação local nunca gravada
      row.status = 'enviado'
      row.waha_message_id = `wamid.${row.id}`
      row.sent_at = iso(Date.now())
      return 'sent'
    },
  }
}

beforeEach(() => {
  resetProviderCallMarkerState()
  resetShutdownGate()
})

const AFTER_RESTART = T0 + 6 * 60_000 // lease (2 min) vencido e item parado há mais de 2 min

describe('restart ANTES da chamada ao provedor: o item não se perde e não é enviado duas vezes', () => {
  it('claim → processo morre → watchdog devolve à fila (sem gastar tentativa) → próximo tick envia: 1 chamada no total', async () => {
    const row = newRow('q1')
    const db = fakeQueue([row])
    const provider = makeProvider()
    claim(row, T0) // reivindicado... e o processo caiu antes de qualquer chamada

    const recovery = await recoverStaleSendingReservations(db, new Date(AFTER_RESTART))
    expect(recovery).toMatchObject({ requeuedNeverSent: 1, finalizedUnknown: 0, failed: 0 })
    expect(row.status).toBe('agendado')
    expect(row.tentativas).toBe(0)
    expect(row.inflight_until).toBeNull()
    expect(row.erro).toBeNull()

    claim(row, AFTER_RESTART) // novo tick reivindica de novo
    expect(await provider.send(db, row)).toBe('sent')
    expect(provider.count('q1')).toBe(1)

    // o watchdog rodando de novo (mesmo bem mais tarde) não mexe num item já enviado
    const again = await recoverStaleSendingReservations(db, new Date(AFTER_RESTART + 10 * 60_000))
    expect(again).toMatchObject({ requeuedNeverSent: 0, finalizedUnknown: 0, recoveredAccepted: 0 })
    expect(provider.count('q1')).toBe(1)
  })
})

describe('restart DEPOIS de marcar a chamada: segue a regra de sempre (erro permanente, NUNCA reenviar)', () => {
  it.each([
    ['o POST saiu e a confirmação local não foi gravada', { crashAfterCall: true }, 1],
    ['morreu entre o marcador e o POST (pode ter saído: o marcador não diz que não)', { crashAfterMark: true }, 0],
  ])('%s', async (_label, crash, callsSoFar) => {
    const row = newRow('q2')
    const db = fakeQueue([row])
    const provider = makeProvider()
    claim(row, T0)
    expect(await provider.send(db, row, crash)).toBe('crash')
    expect(provider.count('q2')).toBe(callsSoFar)
    expect(row.provider_call_started_at).not.toBe(NOT_CALLED_SENTINEL)

    const recovery = await recoverStaleSendingReservations(db, new Date(AFTER_RESTART))
    expect(recovery).toMatchObject({ requeuedNeverSent: 0, finalizedUnknown: 1 })
    expect(row.status).toBe('erro')
    expect(row.erro_permanente).toBe(true)

    // Nenhum tick seguinte reenvia: o item saiu da fila (status 'erro') e não é candidato.
    expect(row.status).not.toBe('agendado')
    await recoverStaleSendingReservations(db, new Date(AFTER_RESTART + 60 * 60_000))
    expect(provider.count('q2')).toBe(callsSoFar)
  })

  it('linha reivindicada ANTES da migration (marcador NULL) também é tratada como incerta: não volta à fila', async () => {
    const row = newRow('q3', { status: 'enviando', updated_at: iso(T0), inflight_until: iso(T0 + 120_000), provider_call_started_at: null })
    const db = fakeQueue([row])
    const recovery = await recoverStaleSendingReservations(db, new Date(AFTER_RESTART))
    expect(recovery).toMatchObject({ requeuedNeverSent: 0, finalizedUnknown: 1 })
    expect(row.status).toBe('erro')
  })

  it('com message id (provedor aceitou): recupera pela confirmação, nunca volta à fila', async () => {
    const row = newRow('q4', { status: 'enviando', updated_at: iso(T0), inflight_until: iso(T0 + 120_000), provider_call_started_at: NOT_CALLED_SENTINEL, waha_message_id: 'wamid.x' })
    const db = fakeQueue([row])
    const recovery = await recoverStaleSendingReservations(db, new Date(AFTER_RESTART))
    expect(recovery).toMatchObject({ requeuedNeverSent: 0, recoveredAccepted: 1 })
    expect(row.status).toBe('enviando') // a RPC fake não altera; o ponto é: NÃO foi para 'agendado'
  })
})

describe('exclusão: dois remetentes do mesmo item nunca fazem duas chamadas', () => {
  it('remetente lento + watchdog devolve à fila + novo claim: só um chega ao provedor', async () => {
    const row = newRow('q5')
    const db = fakeQueue([row])
    const provider = makeProvider()
    claim(row, T0) // o remetente lento A reivindica e demora (ex.: IA) sem marcar

    await recoverStaleSendingReservations(db, new Date(AFTER_RESTART)) // lease vencido: volta à fila
    expect(row.status).toBe('agendado')
    claim(row, AFTER_RESTART) // o remetente B reivindica de novo

    const [a, b] = await Promise.all([provider.send(db, row), provider.send(db, row)]) // A acorda e B envia, juntos
    expect([a, b].filter((r) => r === 'sent')).toHaveLength(1)
    expect([a, b].filter((r) => r === 'lost')).toHaveLength(1)
    expect(provider.count('q5')).toBe(1)
  })

  it('o watchdog não devolve à fila se um remetente vivo marcou entre a leitura e a escrita (UPDATE condicional)', async () => {
    const row = newRow('q6')
    claim(row, T0)
    const provider = makeProvider()
    let armed = false
    const db = fakeQueue([row], {
      beforeUpdate: () => {
        // 1º UPDATE do watchdog: um remetente vivo acabou de gravar o marcador (e vai chamar o provedor)
        if (!armed) {
          armed = true
          row.provider_call_started_at = iso(AFTER_RESTART)
          provider.calls.set('q6', 1)
        }
      },
    })
    const recovery = await recoverStaleSendingReservations(db, new Date(AFTER_RESTART))
    expect(recovery.requeuedNeverSent).toBe(0)
    expect(row.status).toBe('enviando') // não foi para a fila: o remetente vivo é o dono da chamada
    expect(provider.count('q6')).toBe(1)
  })

  it('item devolvido à fila (status != enviando): o remetente que acordar depois NÃO envia', async () => {
    const row = newRow('q7')
    const db = fakeQueue([row])
    const provider = makeProvider()
    claim(row, T0)
    await recoverStaleSendingReservations(db, new Date(AFTER_RESTART)) // volta a 'agendado'
    expect(await provider.send(db, row)).toBe('lost') // o remetente antigo acorda: status não é mais 'enviando'
    expect(provider.count('q7')).toBe(0)
  })
})

describe('releaseUncalledItem', () => {
  it('devolve à fila só quem ainda não chamou; quem já chamou fica como está', async () => {
    const notCalled = newRow('a', { status: 'enviando', provider_call_started_at: NOT_CALLED_SENTINEL, inflight_until: iso(T0) })
    const called = newRow('b', { status: 'enviando', provider_call_started_at: iso(T0), inflight_until: iso(T0) })
    const db = fakeQueue([notCalled, called])
    expect(await releaseUncalledItem(db, 'a')).toBe(true)
    expect(await releaseUncalledItem(db, 'b')).toBe(false)
    expect(notCalled.status).toBe('agendado')
    expect(called.status).toBe('enviando')
  })
})

describe('SIGTERM: espera os envios em voo (teto curto) e só então drena', () => {
  it('aguarda o envio terminar antes de rodar a drenagem das confirmações; novos envios são recusados', async () => {
    const order: string[] = []
    onShutdownAfterSends(async () => void order.push('drain'))
    const slow = trackSend(new Promise<void>((resolve) => setTimeout(() => (order.push('send-done'), resolve()), 30)))
    expect(isShuttingDown()).toBe(false)
    const shutdown = beginShutdown(2_000)
    expect(isShuttingDown()).toBe(true)
    await shutdown
    await slow
    expect(order).toEqual(['send-done', 'drain'])
  })

  it('respeita o teto: envio que não termina não segura a saída além do limite', async () => {
    const never = trackSend(new Promise<void>(() => {}))
    void never
    const t0 = Date.now()
    const pending = await waitForInFlightSends(50)
    expect(pending).toBe(1)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})
