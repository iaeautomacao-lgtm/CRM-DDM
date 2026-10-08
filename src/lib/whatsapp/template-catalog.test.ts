import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pickCatalogRowId, removeSupersededLegacyTemplates, templateKey } from './template-catalog'

type Row = Record<string, unknown>

/** Supabase em memória: só o que template-catalog.ts usa. */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: string[] = []
  const client = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let op: 'select' | 'delete' = 'select'
      const builder: Record<string, unknown> = {}
      builder.select = () => builder
      builder.limit = () => builder
      builder.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder)
      builder.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), builder)
      builder.not = (c: string, _op: string, v: unknown) => (filters.push((r) => (r[c] ?? null) !== v), builder)
      builder.delete = () => ((op = 'delete'), builder)
      builder.upsert = async (rows: Row[]) => {
        calls.push(`upsert:${table}:${rows.length}`)
        for (const row of rows) {
          const exists = tables[table].some((r) => r.team_id === row.team_id && r.template_id === row.template_id)
          if (!exists) tables[table].push(row)
        }
        return { error: null }
      }
      builder.then = (resolve: (v: unknown) => unknown) => {
        const match = (r: Row) => filters.every((f) => f(r))
        if (op === 'delete') {
          calls.push(`delete:${table}`)
          tables[table] = tables[table].filter((r) => !match(r))
          return Promise.resolve({ error: null }).then(resolve)
        }
        return Promise.resolve({ data: tables[table].filter(match), error: null }).then(resolve)
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

describe('pickCatalogRowId (submit/sync)', () => {
  it('linha da WABA primeiro; senão adota a antiga sem waba_id; senão insere', () => {
    const legacy = { id: 'legacy', waba_id: null }
    const specific = { id: 'spec', waba_id: 'w1' }
    expect(pickCatalogRowId([legacy, specific], 'w1')).toBe('spec')
    expect(pickCatalogRowId([legacy], 'w1')).toBe('legacy')
    expect(pickCatalogRowId([], 'w1')).toBeUndefined()
    expect(pickCatalogRowId([legacy], null)).toBe('legacy')
  })
})

describe('removeSupersededLegacyTemplates (sync)', () => {
  const setup = () => ({
    message_templates: [
      { id: 'legacy-pt', account_id: 'acc', name: 'cob', language: 'pt_BR', waba_id: null },
      { id: 'spec-pt', account_id: 'acc', name: 'cob', language: 'pt_BR', waba_id: 'w1' },
      { id: 'legacy-en', account_id: 'acc', name: 'cob', language: 'en_US', waba_id: null },
      { id: 'legacy-off', account_id: 'acc', name: 'antigo', language: 'pt_BR', waba_id: null },
      { id: 'other-acc', account_id: 'acc2', name: 'cob', language: 'pt_BR', waba_id: null },
    ] as Row[],
    team_allowed_templates: [{ team_id: 'team-1', template_id: 'legacy-pt' }] as Row[],
  })

  it('remove só a antiga que tem linha de WABA, levando as permissões de equipe', async () => {
    const tables = setup()
    const { client } = fakeDb(tables)
    const synced = new Set([templateKey('cob', 'pt_BR'), templateKey('cob', 'en_US')])
    const res = await removeSupersededLegacyTemplates(client, 'acc', synced)
    expect(res).toEqual({ removed: 1, errors: [] })
    expect(tables.message_templates.map((r) => r.id)).toEqual(['spec-pt', 'legacy-en', 'legacy-off', 'other-acc'])
    expect(tables.team_allowed_templates).toContainEqual({ team_id: 'team-1', template_id: 'spec-pt' })
  })

  it('template fora do sync (ex.: apagado na Meta) não é tocado', async () => {
    const tables = setup()
    const { client, calls } = fakeDb(tables)
    const res = await removeSupersededLegacyTemplates(client, 'acc', new Set([templateKey('antigo', 'pt_BR')]))
    expect(res.removed).toBe(0)
    expect(calls.some((c) => c.startsWith('delete'))).toBe(false)
  })
})
