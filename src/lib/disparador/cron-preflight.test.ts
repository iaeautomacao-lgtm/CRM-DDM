import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchSchemaReady, PREFLIGHT_OK_TTL_MS, resetPreflightCache } from './cron-preflight'

function dbReturning(results: Array<{ message: string } | null>) {
  let n = 0
  const limit = vi.fn(async () => ({ data: [], error: results[Math.min(n++, results.length - 1)] }))
  const from = vi.fn(() => ({ select: () => ({ limit }) }))
  return { db: { from } as never, limit }
}

beforeEach(() => resetPreflightCache())

describe('dispatchSchemaReady (D-16)', () => {
  it('consulta o banco uma vez e reaproveita o resultado positivo por 10 min', async () => {
    const { db, limit } = dbReturning([null])
    expect(await dispatchSchemaReady(db, 1_000)).toEqual({ ok: true, cached: false })
    expect(await dispatchSchemaReady(db, 1_000 + 9 * 60_000)).toEqual({ ok: true, cached: true })
    expect(limit).toHaveBeenCalledTimes(1)
    expect(await dispatchSchemaReady(db, 1_000 + PREFLIGHT_OK_TTL_MS)).toEqual({ ok: true, cached: false })
    expect(limit).toHaveBeenCalledTimes(2)
  })

  it('falha NUNCA é guardada: coluna ausente continua barrando o tick e confere de novo no próximo', async () => {
    const { db, limit } = dbReturning([{ message: 'column campaigns.next_batch_at does not exist' }, { message: 'ainda ausente' }, null])
    expect(await dispatchSchemaReady(db, 1)).toMatchObject({ ok: false })
    expect(await dispatchSchemaReady(db, 2)).toMatchObject({ ok: false })
    expect(limit).toHaveBeenCalledTimes(2)
    expect(await dispatchSchemaReady(db, 3)).toEqual({ ok: true, cached: false }) // migration aplicada: volta a liberar
  })

  it('positivo em cache e depois falha após o TTL: volta a barrar', async () => {
    const { db } = dbReturning([null, { message: 'rede caiu' }])
    await dispatchSchemaReady(db, 0)
    expect(await dispatchSchemaReady(db, PREFLIGHT_OK_TTL_MS + 1)).toMatchObject({ ok: false })
  })
})
