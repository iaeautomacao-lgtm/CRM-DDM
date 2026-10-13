import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANDIDATE_PAGE_SIZE, fetchDueCandidates, resetDueCandidateColumns } from './due-candidates'

type Row = { id: string; scheduled_at: string }

/** Tabela em memória: filtra por status/vencimento e aplica o keyset como o PostgREST (or com gt / eq+gt). */
function fakeDb(rows: Row[], options: { missingColumnOnExplicit?: boolean } = {}) {
  const queries: Array<{ columns: string; limit: number; cursor: string | null }> = []
  const db = {
    from() {
      let columns = ''
      let cursor: { at: string; id: string } | null = null
      const b: Record<string, unknown> = {}
      b.select = (c: string) => ((columns = c), b)
      b.eq = () => b
      b.lte = () => b
      b.order = () => b
      b.or = (expr: string) => {
        const m = /scheduled_at\.gt\."([^"]+)",and\(scheduled_at\.eq\."[^"]+",id\.gt\."([^"]+)"\)/.exec(expr)!
        cursor = { at: m[1], id: m[2] }
        return b
      }
      b.limit = async (n: number) => {
        queries.push({ columns, limit: n, cursor: cursor ? `${cursor.at}|${cursor.id}` : null })
        if (options.missingColumnOnExplicit && columns !== '*, contacts(name, phone, company)') {
          return { data: null, error: { code: '42703', message: 'column disp_message_queue.phone_attempt_order does not exist' } }
        }
        const sorted = [...rows].sort((x, y) => (x.scheduled_at === y.scheduled_at ? (x.id < y.id ? -1 : 1) : x.scheduled_at < y.scheduled_at ? -1 : 1))
        const after = sorted.filter((r) => !cursor || r.scheduled_at > cursor.at || (r.scheduled_at === cursor.at && r.id > cursor.id))
        return { data: after.slice(0, n), error: null }
      }
      return b
    },
  }
  return { db: db as never, queries }
}

const mk = (n: number, atOf: (i: number) => string = () => '2026-10-09T12:00:00+00:00'): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(5, '0')}`, scheduled_at: atOf(i) }))

beforeEach(() => resetDueCandidateColumns())

describe('fetchDueCandidates (D-09)', () => {
  it('pagina por keyset sem buracos nem repetição, inclusive com muitos itens no MESMO scheduled_at', async () => {
    const rows = mk(2500) // todos no mesmo instante: o desempate por id é o que separa as páginas
    const { db, queries } = fakeDb(rows)
    const items = await fetchDueCandidates(db, 'c1', 5000)
    expect(items.map((i) => i.id)).toEqual(rows.map((r) => r.id))
    expect(new Set(items.map((i) => i.id)).size).toBe(2500)
    expect(queries.map((q) => q.limit)).toEqual([1000, 1000, 1000])
    expect(queries[0].cursor).toBeNull()
    expect(queries[1].cursor).toBe('2026-10-09T12:00:00+00:00|id-00999')
  })

  it('respeita o limite pedido (última página menor) e só lê o necessário', async () => {
    const { db, queries } = fakeDb(mk(10_000, (i) => `2026-10-09T12:${String(Math.floor(i / 200)).padStart(2, '0')}:00+00:00`))
    const items = await fetchDueCandidates(db, 'c1', 2300)
    expect(items).toHaveLength(2300)
    expect(queries.map((q) => q.limit)).toEqual([CANDIDATE_PAGE_SIZE, CANDIDATE_PAGE_SIZE, 300])
  })

  it('pede só as colunas do envio (e o contato), não o select("*")', async () => {
    const { db, queries } = fakeDb(mk(3))
    await fetchDueCandidates(db, 'c1', 10)
    for (const col of ['id', 'campaign_id', 'contact_id', 'session_id', 'tipo', 'mensagem_final', 'media_url', 'tentativas', 'template_name', 'template_language', 'template_variables', 'phone_attempt_order', 'scheduled_at', 'contacts(name, phone, company)']) {
      expect(queries[0].columns).toContain(col)
    }
    expect(queries[0].columns.startsWith('*')).toBe(false)
  })

  it('banco sem alguma coluna (migration 070/077 ausente): volta ao select(*) sozinho, lembra e não perde itens', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, queries } = fakeDb(mk(5), { missingColumnOnExplicit: true })
    expect(await fetchDueCandidates(db, 'c1', 10)).toHaveLength(5)
    expect(queries.map((q) => q.columns.startsWith('*'))).toEqual([false, true])
    await fetchDueCandidates(db, 'c1', 10)
    expect(queries.slice(2).every((q) => q.columns.startsWith('*'))).toBe(true) // lembrou: não tenta o explícito de novo
  })

  it('outro erro do banco sobe (o tick trata como antes)', async () => {
    const db = {
      from: () => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'lte', 'order', 'or']) b[m] = () => b
        b.limit = async () => ({ data: null, error: { code: '57014', message: 'statement timeout' } })
        return b
      },
    } as never
    await expect(fetchDueCandidates(db, 'c1', 10)).rejects.toMatchObject({ code: '57014' })
  })

  it('fila vazia devolve lista vazia numa única consulta', async () => {
    const { db, queries } = fakeDb([])
    expect(await fetchDueCandidates(db, 'c1', 700)).toEqual([])
    expect(queries).toHaveLength(1)
  })
})
