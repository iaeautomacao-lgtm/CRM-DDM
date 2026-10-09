// Migration 317 (auditoria B-07): lease do cron de automações. PGlite com a migration REAL sobre o formato da 006.
// Prova: claim de uma linha vencida por vez (FOR UPDATE SKIP LOCKED); linha 'running' de lease vencido (ou antiga sem
// lease) vira 'failed' com motivo e o log vira 'partial', SEM voltar a rodar; finish só fecha o que ainda está 'running';
// grants só para service_role.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const mig = () =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations/317_automation_pending_lease.sql'), 'utf8').replace(/NOTIFY pgrst[^;]*;/g, '')
let db: PGlite

type Claim = { claimed: Record<string, unknown> | null; reaped: number }
const claim = async (lease = 300) => (await db.query<Claim>(`SELECT * FROM wacrm.claim_automation_pending($1)`, [lease])).rows[0]
const row = async (id: string) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM wacrm.automation_pending_executions WHERE id = $1`, [id])).rows[0]

/** Insere uma execução pendente; runAt/lease são expressões SQL relativas a now(). */
async function add(status: string, runAt: string, opts: { lease?: string; logId?: string } = {}) {
  const res = await db.query<{ id: string }>(
    `INSERT INTO wacrm.automation_pending_executions (automation_id, account_id, user_id, status, run_at, lease_until, log_id)
     VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $1, ${runAt}, ${opts.lease ?? 'NULL'}, $2)
     RETURNING id`,
    [status, opts.logId ?? null],
  )
  return res.rows[0].id
}

describe('migration 317 — lease do cron de automações', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA wacrm; GRANT USAGE ON SCHEMA wacrm TO anon, authenticated, service_role;
      CREATE TABLE wacrm.schema_migrations (version text PRIMARY KEY);
      CREATE TABLE wacrm.automation_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status text NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
        error_message text
      );
      CREATE TABLE wacrm.automation_pending_executions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), automation_id uuid NOT NULL, account_id uuid NOT NULL,
        user_id uuid NOT NULL, contact_id uuid, log_id uuid REFERENCES wacrm.automation_logs(id), parent_step_id uuid,
        branch text, next_step_position integer NOT NULL DEFAULT 0, context jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
        run_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE wacrm.automation_pending_executions ENABLE ROW LEVEL SECURITY;
    `)
    await db.exec(mig())
    await db.exec(mig()) // idempotente
  })
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    await db.exec(`DELETE FROM wacrm.automation_pending_executions; DELETE FROM wacrm.automation_logs;`)
  })

  it('claim pega UMA linha vencida (a mais antiga), marca running com lease e tentativa; futura não entra', async () => {
    const old = await add('pending', `now() - interval '10 minutes'`)
    const newer = await add('pending', `now() - interval '1 minute'`)
    await add('pending', `now() + interval '1 hour'`)
    const c = await claim(120)
    expect(c.claimed?.id).toBe(old)
    const r = await row(old)
    expect(r).toMatchObject({ status: 'running', attempts: 1 })
    const lease = new Date(r.lease_until as string).getTime() - Date.now()
    expect(lease).toBeGreaterThan(100_000)
    expect(lease).toBeLessThanOrEqual(120_000)
    expect((await claim()).claimed?.id).toBe(newer)
    expect((await claim()).claimed).toBeNull()
  })

  it('reaper: running de lease vencido vira failed com motivo e o log vira partial; NÃO volta a rodar', async () => {
    const log = (await db.query<{ id: string }>(`INSERT INTO wacrm.automation_logs (status) VALUES ('success') RETURNING id`)).rows[0].id
    const dead = await add('running', `now() - interval '5 minutes'`, { lease: `now() - interval '1 second'`, logId: log })
    expect(await claim()).toEqual({ claimed: null, reaped: 1 })
    const r = await row(dead)
    expect(r).toMatchObject({ status: 'failed', lease_until: null })
    expect(String(r.error_message)).toMatch(/não repetir envios/)
    const l = (await db.query<{ status: string }>(`SELECT status FROM wacrm.automation_logs WHERE id = $1`, [log])).rows[0]
    expect(l.status).toBe('partial')
    expect((await claim()).reaped).toBe(0) // não volta a contar nem a rodar
    expect((await row(dead)).status).toBe('failed')
  })

  it('reaper: running antigo sem lease (de antes da 317) só depois de 1 h; running com lease vivo fica', async () => {
    const legacy = await add('running', `now() - interval '2 hours'`)
    const recentLegacy = await add('running', `now() - interval '10 minutes'`)
    const alive = await add('running', `now() - interval '2 hours'`, { lease: `now() + interval '4 minutes'` })
    expect((await claim()).reaped).toBe(1)
    expect((await row(legacy)).status).toBe('failed')
    expect((await row(recentLegacy)).status).toBe('running')
    expect((await row(alive)).status).toBe('running')
  })

  it('finish fecha só o que está running (não desfaz o reaper) e limpa o lease; valida argumentos', async () => {
    const id = await add('pending', `now() - interval '1 minute'`)
    await claim()
    expect((await db.query<{ ok: boolean }>(`SELECT wacrm.finish_automation_pending($1, 'done') AS ok`, [id])).rows[0].ok).toBe(true)
    expect(await row(id)).toMatchObject({ status: 'done', lease_until: null })
    expect((await db.query<{ ok: boolean }>(`SELECT wacrm.finish_automation_pending($1, 'failed', 'x') AS ok`, [id])).rows[0].ok).toBe(false)
    expect((await row(id)).status).toBe('done')
    await expect(db.query(`SELECT wacrm.finish_automation_pending($1, 'running')`, [id])).rejects.toThrow(/status inválido/)
    await expect(db.query(`SELECT * FROM wacrm.claim_automation_pending(5)`)).rejects.toThrow(/lease inválido/)
  })

  it('claims seguidos pegam linhas diferentes; a função trava com FOR UPDATE SKIP LOCKED', async () => {
    const a = await add('pending', `now() - interval '2 minutes'`)
    const b = await add('pending', `now() - interval '1 minute'`)
    const def = (await db.query<{ def: string }>(`SELECT pg_get_functiondef('wacrm.claim_automation_pending(integer)'::regprocedure) AS def`)).rows[0].def
    expect(def).toMatch(/FOR UPDATE SKIP LOCKED/)
    const first = await claim()
    const second = await claim()
    expect(new Set([first.claimed?.id, second.claimed?.id])).toEqual(new Set([a, b]))
  })

  it('só service_role executa; registra', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`)
      try {
        await expect(db.query(`SELECT * FROM wacrm.claim_automation_pending(300)`)).rejects.toThrow(/permission denied/)
      } finally {
        await db.exec('RESET ROLE')
      }
    }
    expect((await db.query(`SELECT 1 FROM wacrm.schema_migrations WHERE version = '317_automation_pending_lease'`)).rows).toHaveLength(1)
  })
})
