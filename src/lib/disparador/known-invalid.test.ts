import { describe, expect, it, vi } from 'vitest'
import { isKnownInvalid, loadKnownInvalidContactIds } from './known-invalid'

type Row = Record<string, any>

/** Supabase em memória: contacts (marcados) e contact_phones, com keyset por id. */
function fakeDb(tables: Record<string, Row[]>, options: { missingColumn?: boolean; alternatesError?: boolean } = {}) {
  const pages: number[] = []
  return {
    pages,
    db: {
      from(table: string) {
        let rows = [...(tables[table] ?? [])]
        let limitN = Infinity
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b)
        b.in = (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[c]))), b)
        b.gt = (c: string, v: unknown) => ((rows = rows.filter((r) => (typeof r[c] === 'number' ? r[c] > Number(v) : String(r[c]) > String(v)))), b)
        b.not = (c: string) => ((rows = rows.filter((r) => r[c] != null)), b)
        b.order = (c: string) => ((rows = rows.sort((x, y) => (String(x[c]) < String(y[c]) ? -1 : 1))), b)
        b.limit = (n: number) => ((limitN = n), b)
        b.then = (resolve: (v: unknown) => void) => {
          if (table === 'contacts' && options.missingColumn) return resolve({ data: null, error: { code: '42703', message: 'column contacts.phone_invalid_at does not exist' } })
          if (table === 'contact_phones' && options.alternatesError) return resolve({ data: null, error: { message: 'timeout' } })
          if (table === 'contacts') pages.push(rows.slice(0, limitN).length)
          return resolve({ data: rows.slice(0, limitN), error: null })
        }
        return b
      },
    } as never,
  }
}

describe('isKnownInvalid (a marca só vale enquanto o telefone não mudou)', () => {
  it('mesmo normalizado = vale; telefone mudou = não vale; sem marca ou sem telefone = não vale', () => {
    expect(isKnownInvalid({ phone_normalized: '5511999998888', phone_invalid_normalized: '5511999998888' })).toBe(true)
    expect(isKnownInvalid({ phone_normalized: '5511988887777', phone_invalid_normalized: '5511999998888' })).toBe(false)
    expect(isKnownInvalid({ phone_normalized: '5511999998888', phone_invalid_normalized: null })).toBe(false)
    expect(isKnownInvalid({ phone_normalized: null, phone_invalid_normalized: '5511999998888' })).toBe(false)
  })
})

describe('loadKnownInvalidContactIds', () => {
  const contacts = [
    { id: 'a', account_id: 'acc', phone_normalized: '551111', phone_invalid_normalized: '551111', phone_invalid_at: '2026-10-01T00:00:00Z' }, // marcado e igual → pula
    { id: 'b', account_id: 'acc', phone_normalized: '552222', phone_invalid_normalized: '559999', phone_invalid_at: '2026-10-01T00:00:00Z' }, // telefone mudou → segue
    { id: 'c', account_id: 'acc', phone_normalized: '553333', phone_invalid_normalized: '553333', phone_invalid_at: '2026-10-01T00:00:00Z' }, // marcado, tem alternativo ok → segue
    { id: 'd', account_id: 'acc', phone_normalized: '554444', phone_invalid_normalized: '554444', phone_invalid_at: '2026-10-01T00:00:00Z' }, // alternativo também inválido → pula
    { id: 'e', account_id: 'acc', phone_normalized: '555555', phone_invalid_normalized: '555555', phone_invalid_at: '2026-10-01T00:00:00Z' }, // marcado mas FORA do público → ignora
    { id: 'x', account_id: 'outra', phone_normalized: '556666', phone_invalid_normalized: '556666', phone_invalid_at: '2026-10-01T00:00:00Z' }, // outra conta
    { id: 'f', account_id: 'acc', phone_normalized: '557777', phone_invalid_normalized: null, phone_invalid_at: null }, // sem marca
  ]
  const phones = [
    { contact_id: 'c', ordem: 2, status: 'ativo' },
    { contact_id: 'd', ordem: 2, status: 'invalido' },
    { contact_id: 'd', ordem: 3, status: 'invalido' },
  ]
  const audience = new Set(['a', 'b', 'c', 'd', 'f', 'x'])

  it('pula só quem tem marca válida e nenhum telefone alternativo utilizável; ignora outra conta e quem está fora do público', async () => {
    const { db } = fakeDb({ contacts, contact_phones: phones })
    const r = await loadKnownInvalidContactIds(db, 'acc', audience)
    expect([...r.skip].sort()).toEqual(['a', 'd'])
    expect(r.marked).toBe(3) // a, c, d (b mudou de telefone; e está fora do público)
  })

  it('migration 335 ausente (coluna inexistente): ninguém é pulado, sem alarme', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = fakeDb({ contacts, contact_phones: phones }, { missingColumn: true })
    expect(await loadKnownInvalidContactIds(db, 'acc', audience)).toEqual({ skip: new Set(), marked: 0 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('falha ao ler os telefones alternativos: ninguém é pulado (nunca derruba a campanha) e registra o erro', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = fakeDb({ contacts, contact_phones: phones }, { alternatesError: true })
    expect((await loadKnownInvalidContactIds(db, 'acc', audience)).skip.size).toBe(0)
    expect(spy).toHaveBeenCalled()
  })

  it('conta sem nenhuma marca: lista vazia', async () => {
    const { db } = fakeDb({ contacts: contacts.filter((c) => c.phone_invalid_at === null), contact_phones: phones })
    expect(await loadKnownInvalidContactIds(db, 'acc', audience)).toEqual({ skip: new Set(), marked: 0 })
  })
})
