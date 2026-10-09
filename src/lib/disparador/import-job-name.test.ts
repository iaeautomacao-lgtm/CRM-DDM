import { describe, expect, it } from 'vitest'
import { createImportJob, parseListName, toPublicImportJob, type ImportJob } from './import-jobs'

const args = { accountId: 'acc', userId: 'u', campaignId: null, draftId: null, columnMap: { phone: 'tel' }, mappingConfirmed: true }

function fakeDb(failNameColumn: boolean) {
  const inserts: Array<Record<string, unknown>> = []
  const db = {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row)
        const result = failNameColumn && 'name' in row
          ? { data: null, error: { code: '42703', message: 'column "name" does not exist' } }
          : { data: [{ id: 'j1', ...row }], error: null }
        return { select: () => ({ limit: async () => result }) }
      },
    }),
  }
  return { db: db as never, inserts }
}

describe('parseListName', () => {
  it('apara/compacta espaços; vazio = não informado; inválido = null', () => {
    expect(parseListName('  Lista   A  ')).toBe('Lista A')
    expect(parseListName(undefined)).toBeUndefined()
    expect(parseListName('')).toBeUndefined()
    expect(parseListName(null)).toBeUndefined()
    expect(parseListName('   ')).toBeNull()
    expect(parseListName('x'.repeat(121))).toBeNull()
    expect(parseListName(42)).toBeNull()
    expect(parseListName('x'.repeat(120))).toBe('x'.repeat(120))
  })
})

describe('createImportJob com nome da lista (migration 292)', () => {
  it('grava o nome quando informado e não envia a coluna quando não há nome', async () => {
    const withName = fakeDb(false)
    const r = await createImportJob(withName.db, { ...args, name: 'Inadimplentes' })
    expect(r.ok).toBe(true)
    expect(withName.inserts[0]).toMatchObject({ name: 'Inadimplentes' })
    const noName = fakeDb(false)
    await createImportJob(noName.db, args)
    expect(noName.inserts[0]).not.toHaveProperty('name')
  })

  it('sem a migration 292 (coluna ausente) a importação é criada SEM o nome — o nome nunca bloqueia importar', async () => {
    const f = fakeDb(true)
    const r = await createImportJob(f.db, { ...args, name: 'Inadimplentes' })
    expect(r.ok).toBe(true)
    expect(f.inserts).toHaveLength(2)
    expect(f.inserts[1]).not.toHaveProperty('name')
  })
})

describe('toPublicImportJob', () => {
  it('inclui o nome (null quando não há)', () => {
    expect(toPublicImportJob({ id: 'j', name: 'A', blocks: {}, rows_total: 0, rows_done: 0, errors: [] } as unknown as ImportJob).name).toBe('A')
    expect(toPublicImportJob({ id: 'j', blocks: {}, rows_total: 0, rows_done: 0, errors: [] } as unknown as ImportJob).name).toBeNull()
  })
})
