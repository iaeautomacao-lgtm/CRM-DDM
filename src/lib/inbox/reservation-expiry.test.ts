// Expiração da reserva do @operador (30 min com o operador em pausa ou offline). Regra pura + serviço sobre o banco em memória.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/audit/log-event', () => ({ logAuditEvent: audit }))

import { createMemoryDb, type SimTables } from '@/lib/flows/simulator/memory-db'
import { PRESENCE_WINDOW_MS, RESERVATION_EXPIRY_MS, expireStaleReservations, reservationExpiryReason } from './reservation-expiry'

const NOW = Date.parse('2026-10-16T15:00:00.000Z')
const MIN = 60_000
const ago = (min: number, extraMs = 0) => new Date(NOW - min * MIN - extraMs).toISOString()
const fresh = () => new Date(NOW - 10_000).toISOString() // batimento de 10 s atrás

const ACC = 'acc-1'
const AG = 'agent-1'

describe('constantes', () => {
  it('30 min e a régua de 75 s dos seletores (constante única, não configuração)', () => {
    expect(RESERVATION_EXPIRY_MS).toBe(30 * 60_000)
    expect(PRESENCE_WINDOW_MS).toBe(75_000)
  })
})

describe('reservationExpiryReason (a regra)', () => {
  const base = { now: NOW, requestedAt: ago(45), pauseStartedAt: null, presence: { status: 'online', lastSeenAt: fresh() } }

  it('sem data de início da reserva (reserva antiga ou migration 384 ausente): nunca expira', () => {
    expect(reservationExpiryReason({ ...base, requestedAt: null, presence: null })).toBeNull()
    expect(reservationExpiryReason({ ...base, requestedAt: 'lixo', presence: null })).toBeNull()
  })

  it('reserva com menos de 30 min nunca expira, mesmo com o operador pausado há horas ou offline', () => {
    expect(reservationExpiryReason({ ...base, requestedAt: ago(29, 59_000), pauseStartedAt: ago(300), presence: null })).toBeNull()
  })

  it('PAUSA: 29 min não expira; 31 min expira (reserva já com 45 min, operador online)', () => {
    expect(reservationExpiryReason({ ...base, pauseStartedAt: ago(29) })).toBeNull()
    expect(reservationExpiryReason({ ...base, pauseStartedAt: ago(31) })).toBe('pause')
    expect(reservationExpiryReason({ ...base, pauseStartedAt: ago(30) })).toBe('pause') // exatamente 30: já vale (≥)
  })

  it('PAUSA: só conta a pausa ATUAL; sem pausa aberta (voltou a tempo) e presente, mantém', () => {
    expect(reservationExpiryReason({ ...base, pauseStartedAt: null })).toBeNull()
  })

  it('OFFLINE: último batimento há 29 min mantém; há 31 min expira', () => {
    expect(reservationExpiryReason({ ...base, presence: { status: 'online', lastSeenAt: ago(29) } })).toBeNull()
    expect(reservationExpiryReason({ ...base, presence: { status: 'online', lastSeenAt: ago(31) } })).toBe('offline')
  })

  it('OFFLINE: sem linha de presença conta offline desde o começo da reserva (45 min → expira)', () => {
    expect(reservationExpiryReason({ ...base, presence: null })).toBe('offline')
    expect(reservationExpiryReason({ ...base, requestedAt: ago(31), presence: null })).toBe('offline')
  })

  it("régua de 75 s: batimento de 2 min atrás já é 'não presente', mas offline há só 2 min mantém a reserva", () => {
    expect(reservationExpiryReason({ ...base, presence: { status: 'online', lastSeenAt: ago(2) } })).toBeNull()
    expect(reservationExpiryReason({ ...base, presence: { status: 'online', lastSeenAt: new Date(NOW - 74_000).toISOString() } })).toBeNull()
  })

  it("'away' com batimento fresco conta como presente (igual ao fallback dos seletores); 'away' com batimento velho é offline", () => {
    expect(reservationExpiryReason({ ...base, presence: { status: 'away', lastSeenAt: fresh() } })).toBeNull()
    expect(reservationExpiryReason({ ...base, presence: { status: 'away', lastSeenAt: ago(40) } })).toBe('offline')
  })

  it('pausa tem prioridade como motivo; presente e pausado há 31 min expira por pausa', () => {
    expect(reservationExpiryReason({ ...base, pauseStartedAt: ago(31), presence: { status: 'online', lastSeenAt: ago(40) } })).toBe('pause')
  })

  it('voltou a tempo: offline há 20 min e o batimento voltou; ou pausa de 20 min que continua: mantém', () => {
    expect(reservationExpiryReason({ ...base, presence: { status: 'online', lastSeenAt: fresh() } })).toBeNull()
    expect(reservationExpiryReason({ ...base, pauseStartedAt: ago(20) })).toBeNull()
  })
})

function seed(over: Partial<SimTables> = {}): SimTables {
  return {
    conversations: [
      { id: 'c1', account_id: ACC, team_id: 't1', contact_id: 'ct1', status: 'pending', assigned_agent_id: null, requested_agent_id: AG, requested_at: ago(45) },
    ],
    member_presence: [{ user_id: AG, status: 'online', last_seen_at: fresh() }],
    agent_pauses: [],
    ...over,
  }
}
const dbOf = (t: SimTables) => createMemoryDb({ tables: t, clock: { last: 0 } }) as never
const reserved = (t: SimTables, id = 'c1') => (t.conversations.find((c) => c.id === id) as { requested_agent_id: string | null }).requested_agent_id
const pause = (startedMinAgo: number) => ({ id: 'p1', user_id: AG, account_id: ACC, reason_name: 'Almoço', started_at: ago(startedMinAgo), ended_at: null })

/** Banco que roda `hook` logo ANTES de resolver a 1ª consulta de `table` (simula uma gravação concorrente entre a leitura e o UPDATE da rotina). */
function beforeResolving(real: { from: (x: string) => Record<string, unknown> }, table: string, hook: () => void) {
  let done = false
  const wrap = (target: Record<string, unknown>): Record<string, unknown> => {
    const proxy: Record<string, unknown> = new Proxy(target, {
      get(t, prop) {
        if (prop === 'then') {
          return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
            if (!done) {
              done = true
              hook()
            }
            return (t.then as (a: unknown, b: unknown) => unknown)(ok, bad)
          }
        }
        const v = t[prop as string]
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          const r = (v as (...a: unknown[]) => unknown).apply(t, args)
          return r === t ? proxy : r // o encadeamento fica dentro do proxy
        }
      },
    })
    return proxy
  }
  return { ...real, from: (name: string) => (name === table ? wrap(real.from(name)) : real.from(name)) }
}

beforeEach(() => {
  audit.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('expireStaleReservations', () => {
  it('pausado há 31 min: libera, devolve a conversa para o mesmo tick e audita só com ids', async () => {
    const t = seed({ agent_pauses: [pause(31)] })
    const out = await expireStaleReservations(dbOf(t), NOW)
    expect(out).toEqual([{ id: 'c1', team_id: 't1', account_id: ACC, contact_id: 'ct1' }])
    expect(reserved(t)).toBeNull()
    expect(audit).toHaveBeenCalledTimes(1)
    const call = (audit.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(call).toMatchObject({ accountId: ACC, eventType: 'action', resourceType: 'conversation', resourceId: 'c1', action: 'conversation.reservation_expired', metadata: { agent_id: AG, reason: 'pause', after_minutes: 30 } })
    expect(JSON.stringify(call)).not.toMatch(/phone|full_name|content|message_text/) // só ids, motivo e minutos
  })

  it('pausado há 29 min: mantém', async () => {
    const t = seed({ agent_pauses: [pause(29)] })
    expect(await expireStaleReservations(dbOf(t), NOW)).toEqual([])
    expect(reserved(t)).toBe(AG)
    expect(audit).not.toHaveBeenCalled()
  })

  it('offline há 31 min libera (motivo offline); há 29 min mantém; sem presença nenhuma libera', async () => {
    const off31 = seed({ member_presence: [{ user_id: AG, status: 'online', last_seen_at: ago(31) }] })
    expect(await expireStaleReservations(dbOf(off31), NOW)).toHaveLength(1)
    expect((audit.mock.calls[0] as unknown as [{ metadata: { reason: string } }])[0].metadata.reason).toBe('offline')
    const off29 = seed({ member_presence: [{ user_id: AG, status: 'online', last_seen_at: ago(29) }] })
    expect(await expireStaleReservations(dbOf(off29), NOW)).toEqual([])
    expect(reserved(off29)).toBe(AG)
    const none = seed({ member_presence: [] })
    expect(await expireStaleReservations(dbOf(none), NOW)).toHaveLength(1)
  })

  it('voltou a tempo: operador online e fora de pausa mantém a reserva, mesmo velha', async () => {
    const t = seed()
    expect(await expireStaleReservations(dbOf(t), NOW)).toEqual([])
    expect(reserved(t)).toBe(AG)
  })

  it('reserva com menos de 30 min não expira (a busca nem a traz)', async () => {
    const t = seed({ agent_pauses: [pause(120)], member_presence: [] })
    ;(t.conversations[0] as { requested_at: string }).requested_at = ago(29, 30_000)
    expect(await expireStaleReservations(dbOf(t), NOW)).toEqual([])
    expect(reserved(t)).toBe(AG)
  })

  it('sem a migration 384/376 (linha sem requested_at, ou coluna inexistente): não expira e não lança', async () => {
    const legacy = seed({ agent_pauses: [pause(120)], member_presence: [] })
    delete (legacy.conversations[0] as { requested_at?: string }).requested_at
    expect(await expireStaleReservations(dbOf(legacy), NOW)).toEqual([])
    expect(reserved(legacy)).toBe(AG)

    const real = createMemoryDb({ tables: seed(), clock: { last: 0 } }) as unknown as { from: (t: string) => Record<string, unknown> }
    const noColumn = {
      ...real,
      from: (table: string) => {
        if (table !== 'conversations') return real.from(table)
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'is', 'neq', 'lte', 'order', 'limit']) b[m] = () => b
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: '42703', message: 'column conversations.requested_at does not exist' } }).then(ok)
        return b
      },
    }
    await expect(expireStaleReservations(noColumn as never, NOW)).resolves.toEqual([])
  })

  it('não age no escuro: falha ao ler pausas ou presença = nenhuma reserva expira', async () => {
    const mk = (broken: 'agent_pauses' | 'member_presence') => {
      const t = seed({ agent_pauses: [pause(120)], member_presence: [] })
      const real = createMemoryDb({ tables: t, clock: { last: 0 } }) as unknown as { from: (x: string) => Record<string, unknown> }
      const db = {
        ...real,
        from: (table: string) => {
          if (table !== broken) return real.from(table)
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'in', 'is', 'eq']) b[m] = () => b
          b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: '57014', message: 'timeout' } }).then(ok)
          return b
        },
      }
      return { t, db: db as never }
    }
    for (const broken of ['agent_pauses', 'member_presence'] as const) {
      const { t, db } = mk(broken)
      expect(await expireStaleReservations(db, NOW)).toEqual([])
      expect(reserved(t)).toBe(AG)
    }
  })

  it('sem a migration 370 (tabela de pausas inexistente) não há pausa: só vale o offline', async () => {
    const t = seed({ member_presence: [{ user_id: AG, status: 'online', last_seen_at: fresh() }] })
    const real = createMemoryDb({ tables: t, clock: { last: 0 } }) as unknown as { from: (x: string) => Record<string, unknown> }
    const db = {
      ...real,
      from: (table: string) => {
        if (table !== 'agent_pauses') return real.from(table)
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'in', 'is']) b[m] = () => b
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } }).then(ok)
        return b
      },
    }
    expect(await expireStaleReservations(db as never, NOW)).toEqual([]) // online e fresco: mantém
    expect(reserved(t)).toBe(AG)
  })

  it('corrida: o operador ASSUME entre a leitura e a gravação — o compare-and-set não libera nada e não audita', async () => {
    const t = seed({ agent_pauses: [pause(60)] })
    const real = createMemoryDb({ tables: t, clock: { last: 0 } }) as unknown as { from: (x: string) => Record<string, unknown> }
    // o operador assume logo depois de a rotina ler as pausas (o trigger da 376 já zeraria a reserva; aqui só marca o atendente)
    const db = beforeResolving(real, 'agent_pauses', () => {
      ;(t.conversations[0] as { assigned_agent_id: string | null }).assigned_agent_id = AG
    })
    expect(await expireStaleReservations(db as never, NOW)).toEqual([])
    expect((t.conversations[0] as { assigned_agent_id: string | null }).assigned_agent_id).toBe(AG)
    expect(reserved(t)).toBe(AG) // a gravação não encostou na conversa já assumida
    expect(audit).not.toHaveBeenCalled()
  })

  it('corrida: re-reservada para OUTRO operador entre a leitura e a gravação — não libera', async () => {
    const t = seed({ agent_pauses: [pause(60)] })
    const real = createMemoryDb({ tables: t, clock: { last: 0 } }) as unknown as { from: (x: string) => Record<string, unknown> }
    const db = beforeResolving(real, 'agent_pauses', () => {
      ;(t.conversations[0] as { requested_agent_id: string }).requested_agent_id = 'agent-2'
    })
    expect(await expireStaleReservations(db as never, NOW)).toEqual([])
    expect(reserved(t)).toBe('agent-2')
  })

  it('conversa fechada ou já com atendente nem entra na busca; várias reservas: libera só as que cumprem a regra', async () => {
    const t = seed({
      conversations: [
        { id: 'fechada', account_id: ACC, team_id: null, contact_id: 'x', status: 'closed', assigned_agent_id: null, requested_agent_id: AG, requested_at: ago(60) },
        { id: 'assumida', account_id: ACC, team_id: null, contact_id: 'x', status: 'open', assigned_agent_id: 'u9', requested_agent_id: AG, requested_at: ago(60) },
        { id: 'velha-pausa', account_id: ACC, team_id: 't1', contact_id: 'y', status: 'pending', assigned_agent_id: null, requested_agent_id: AG, requested_at: ago(60) },
        { id: 'outro-op-presente', account_id: ACC, team_id: 't1', contact_id: 'z', status: 'pending', assigned_agent_id: null, requested_agent_id: 'agent-2', requested_at: ago(60) },
      ],
      agent_pauses: [pause(40)],
      member_presence: [
        { user_id: AG, status: 'online', last_seen_at: fresh() },
        { user_id: 'agent-2', status: 'online', last_seen_at: fresh() },
      ],
    })
    const out = await expireStaleReservations(dbOf(t), NOW)
    expect(out.map((c) => c.id)).toEqual(['velha-pausa'])
    expect(reserved(t, 'fechada')).toBe(AG)
    expect(reserved(t, 'assumida')).toBe(AG)
    expect(reserved(t, 'outro-op-presente')).toBe('agent-2')
    expect(reserved(t, 'velha-pausa')).toBeNull()
  })
})
