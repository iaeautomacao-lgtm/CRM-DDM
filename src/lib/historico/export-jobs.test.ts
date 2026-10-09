import { describe, expect, it } from 'vitest'
import {
  createHistoryExportJob, historyExportCells, parseHistoryExportRequest, processHistoryExportJob, toPublicHistoryExportJob,
  type HistoryExportJob,
} from './export-jobs'

type Row = Record<string, any>

/** Supabase + Storage em memória (só o que o módulo usa). */
function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { history_export_jobs: [], export_history: [], profiles: [], teams: [], tags: [], conversations: [], ...seed }
  const files = new Map<string, Buffer>()
  let seq = 0
  const db = {
    from(table: string) {
      let rows = tables[table] ?? (tables[table] = [])
      let op: 'select' | 'insert' | 'update' = 'select'
      let payload: Row = {}
      let head = false
      let limitN = Infinity
      const filters: Array<(r: Row) => boolean> = []
      const b: Record<string, any> = {}
      b.select = (_c?: string, o?: { head?: boolean }) => ((head = !!o?.head), b)
      b.insert = (p: Row) => ((op = 'insert'), (payload = p), b)
      b.update = (p: Row) => ((op = 'update'), (payload = p), b)
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b)
      b.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b)
      b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b)
      b.gte = (c: string, v: string) => (filters.push((r) => Date.parse(r[c]) >= Date.parse(v)), b)
      b.lt = (c: string, v: string) => (filters.push((r) => Date.parse(r[c]) < Date.parse(v)), b)
      b.gt = (c: string, v: string) => (filters.push((r) => String(r[c]) > v), b)
      b.order = (c: string, o: { ascending: boolean }) => (
        (rows = [...rows].sort((x, y) => (String(x[c]) < String(y[c]) ? -1 : 1) * (o.ascending ? 1 : -1))), b)
      b.limit = (n: number) => ((limitN = n), b)
      b.then = (resolve: (v: unknown) => void) => {
        const match = rows.filter((r) => filters.every((f) => f(r)))
        if (op === 'insert') {
          const created = { id: payload.id ?? `ID-${++seq}`, state: 'pending', rows_done: 0, parts_count: 0, attempts: 0, truncated: false, cursor_id: null, created_at: '2026-10-09T12:00:00Z', ...payload }
          ;(tables[table] ??= []).push(created)
          return resolve({ data: [created], error: null })
        }
        if (op === 'update') {
          match.forEach((r) => Object.assign(r, payload))
          return resolve({ data: null, error: null })
        }
        if (head) return resolve({ count: match.length, data: null, error: null })
        return resolve({ data: match.slice(0, limitN), error: null })
      }
      return b
    },
    storage: {
      from: () => ({
        upload: async (path: string, body: Buffer) => (files.set(path, body), { error: null }),
        download: async (path: string) => {
          const f = files.get(path)
          return f ? { data: new Blob([new Uint8Array(f)]), error: null } : { data: null, error: { message: 'ausente' } }
        },
        remove: async (paths: string[]) => (paths.forEach((p) => files.delete(p)), { error: null }),
      }),
    },
  }
  return { db: db as never, tables, files }
}

const ACC = 'acc'
const conv = (n: number, over: Row = {}): Row => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  account_id: ACC, status: 'closed', created_at: '2026-10-05T10:00:00Z', closed_at: '2026-10-05T10:30:00Z',
  assigned_agent_id: 'u1', team_id: 't1', waha_session: null, channel_type: 'whatsapp', outcome_tag_id: 'tag1',
  outcome_tag: { name: 'Acordo' }, contact: { name: `Cliente ${n}`, phone: `5511900000${n}` }, ...over,
})
const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' }

describe('parseHistoryExportRequest', () => {
  it('aceita período ISO e tabulação opcional', () => {
    expect(parseHistoryExportRequest({ period_from: '2026-10-01', period_to: '2026-10-09' })).toMatchObject({ ok: true, tabulacaoId: null })
    expect(parseHistoryExportRequest({ period_from: '2026-10-01', period_to: '2026-10-09', tabulacao_id: '11111111-1111-4111-8111-111111111111' })).toMatchObject({ ok: true })
  })
  it('recusa período ausente/invertido/maior que 366 dias e tabulação que não é uuid', () => {
    expect(parseHistoryExportRequest({})).toMatchObject({ ok: false })
    expect(parseHistoryExportRequest({ period_from: '2026-10-09', period_to: '2026-10-01' })).toMatchObject({ ok: false })
    expect(parseHistoryExportRequest({ period_from: '2024-01-01', period_to: '2026-10-01' })).toMatchObject({ ok: false })
    expect(parseHistoryExportRequest({ period_from: '2026-10-01', period_to: '2026-10-09', tabulacao_id: 'x' })).toMatchObject({ ok: false })
  })
})

describe('historyExportCells', () => {
  it('monta a linha com nomes de equipe/atendente, canal e duração', () => {
    const cells = historyExportCells(conv(1) as never, { agents: new Map([['u1', 'Ana']]), teams: new Map([['t1', 'Cobrança']]) })
    expect(cells.slice(0, 6)).toEqual(['Cliente 1', '55119000001', 'WhatsApp', 'Cobrança', 'Ana', 'Acordo'])
    expect(cells[8]).toBe('30 min')
  })
  it('webchat e sem tabulação/equipe viram rótulos neutros', () => {
    const cells = historyExportCells(conv(2, { channel_type: 'webchat', outcome_tag: null, team_id: null, assigned_agent_id: null }) as never, { agents: new Map(), teams: new Map() })
    expect(cells.slice(2, 6)).toEqual(['Webchat', '-', '-', '-'])
  })
})

describe('createHistoryExportJob', () => {
  it('cria o job com a contagem; pedido igual em andamento é reaproveitado', async () => {
    const { db, tables } = fakeDb({ conversations: [conv(1), conv(2), conv(3, { status: 'open' })] })
    const a = await createHistoryExportJob(db, { accountId: ACC, userId: 'u1', ...range, tabulacaoId: null })
    expect(a).toMatchObject({ ok: true, reused: false })
    expect(tables.history_export_jobs[0].total_rows).toBe(2)
    const b = await createHistoryExportJob(db, { accountId: ACC, userId: 'u1', ...range, tabulacaoId: null })
    expect(b).toMatchObject({ ok: true, reused: true })
    expect(tables.history_export_jobs).toHaveLength(1)
  })
  it('tabulação de outra conta é recusada', async () => {
    const { db } = fakeDb({ tags: [{ id: 'tagX', account_id: 'outra' }] })
    expect(await createHistoryExportJob(db, { accountId: ACC, userId: null, ...range, tabulacaoId: 'tagX' })).toMatchObject({ ok: false, code: 'tabulacao_not_found' })
  })
  it('conta só as da tabulação pedida', async () => {
    const { db, tables } = fakeDb({ tags: [{ id: 'tag1', account_id: ACC }], conversations: [conv(1), conv(2, { outcome_tag_id: 'tag9' })] })
    await createHistoryExportJob(db, { accountId: ACC, userId: null, ...range, tabulacaoId: 'tag1' })
    expect(tables.history_export_jobs[0].total_rows).toBe(1)
  })
})

describe('processHistoryExportJob', () => {
  const claim = (tables: Record<string, Row[]>): HistoryExportJob => {
    const job = tables.history_export_jobs[0]
    job.state = 'running'
    job.owner_id = 'o1'
    return { ...job } as HistoryExportJob
  }

  it('lê só as conversas do filtro, gera o CSV, registra em Exportações e conclui', async () => {
    const { db, tables, files } = fakeDb({
      conversations: [
        conv(1), conv(2), conv(3, { outcome_tag_id: 'tag9' }), conv(4, { account_id: 'outra' }),
        conv(5, { closed_at: '2026-09-01T00:00:00Z' }), conv(6, { status: 'open' }),
      ],
      tags: [{ id: 'tag1', account_id: ACC }],
      profiles: [{ user_id: 'u1', full_name: 'Ana' }],
      teams: [{ id: 't1', account_id: ACC, name: 'Cobrança' }],
    })
    await createHistoryExportJob(db, { accountId: ACC, userId: 'u1', ...range, tabulacaoId: 'tag1' })
    const result = await processHistoryExportJob(db, claim(tables), { owner: 'o1' })
    expect(result).toBe('done')
    const job = tables.history_export_jobs[0]
    expect(job).toMatchObject({ state: 'done', rows_done: 2, truncated: false })
    const csv = files.get(job.file_path)!.toString('utf8')
    expect(csv.startsWith('﻿Contato;')).toBe(true)
    expect(csv).toContain('Cliente 1')
    expect(csv).toContain('Cliente 2')
    expect(csv).not.toContain('Cliente 3')
    expect(csv).not.toContain('Cliente 4')
    expect(csv).toContain('Cobrança')
    // partes apagadas, arquivo final no prefixo da conta, linha em Exportações
    expect([...files.keys()].every((p) => p.startsWith(`${ACC}/historico-exports/`) && !p.includes('/parts/'))).toBe(true)
    expect(tables.export_history[0]).toMatchObject({ account_id: ACC, export_type: 'conversas', storage_path: job.file_path, user_name: 'Ana' })
    expect(job.export_history_id).toBe(tables.export_history[0].id)
  })

  it('retoma do cursor e não duplica a linha em Exportações ao repetir a finalização', async () => {
    const { db, tables } = fakeDb({ conversations: [conv(1), conv(2)] })
    await createHistoryExportJob(db, { accountId: ACC, userId: null, ...range, tabulacaoId: null })
    const j = claim(tables)
    await processHistoryExportJob(db, j, { owner: 'o1' })
    // simula "crash depois de registrar e antes de concluir": job volta a running com o id do histórico já gravado
    Object.assign(tables.history_export_jobs[0], { state: 'running', owner_id: 'o1' })
    const again = { ...tables.history_export_jobs[0] } as HistoryExportJob
    await processHistoryExportJob(db, again, { owner: 'o1' })
    expect(tables.export_history).toHaveLength(1)
  })

  it('erro vira retry com atraso e, na 3ª tentativa, failed', async () => {
    const { db, tables } = fakeDb({ conversations: [conv(1)] })
    await createHistoryExportJob(db, { accountId: ACC, userId: null, ...range, tabulacaoId: null })
    ;(db as any).storage.from = () => ({ upload: async () => ({ error: { message: 'storage fora' } }) })
    expect(await processHistoryExportJob(db, claim(tables), { owner: 'o1' })).toBe('retry')
    expect(tables.history_export_jobs[0]).toMatchObject({ state: 'pending', attempts: 1, last_error: 'Falha ao gravar a parte 1: storage fora' })
    Object.assign(tables.history_export_jobs[0], { state: 'running', owner_id: 'o1', attempts: 2 })
    expect(await processHistoryExportJob(db, { ...tables.history_export_jobs[0] } as HistoryExportJob, { owner: 'o1' })).toBe('failed')
    expect(tables.history_export_jobs[0].state).toBe('failed')
  })

  it('formato público não expõe caminho de arquivo nem dono', () => {
    const pub = toPublicHistoryExportJob({ ...(conv(1) as never), state: 'done', file_path: 'segredo', rows_done: 2, total_rows: 2 } as unknown as HistoryExportJob)
    expect(JSON.stringify(pub)).not.toContain('segredo')
    expect(pub.progress).toBe(1)
  })
})
