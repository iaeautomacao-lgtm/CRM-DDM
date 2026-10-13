import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))

import { CRON_JOBS, heartbeatStatusFor, recordCronHeartbeat, trackCron } from './cron-heartbeat'

type Call = { fn: string; args: Record<string, unknown> }
function fakeRpc(error: { code?: string; message: string } | null = null) {
  const calls: Call[] = []
  return { db: { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), { error }) }, calls }
}

describe('heartbeatStatusFor', () => {
  it('401 (sonda com segredo errado) NÃO é execução do cron; 2xx/202 = ok; o resto = erro', () => {
    expect(heartbeatStatusFor(401)).toBeNull()
    expect(heartbeatStatusFor(200)).toBe('ok')
    expect(heartbeatStatusFor(202)).toBe('ok')
    expect(heartbeatStatusFor(503)).toBe('error') // "cron not configured" também precisa aparecer
    expect(heartbeatStatusFor(500)).toBe('error')
  })
})

describe('trackCron', () => {
  it('devolve a MESMA resposta e registra ok com a cadência do job', async () => {
    const { db, calls } = fakeRpc()
    const response = new Response(JSON.stringify({ status: 'idle' }), { status: 200 })
    const out = await trackCron('disparador_prepare', async () => response, db)
    expect(out).toBe(response)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ fn: 'cron_heartbeat_record', args: { p_job: 'disparador_prepare', p_expected_every_seconds: 60, p_status: 'ok', p_error: null } })
  })

  it('resposta 503 vira batimento de erro com o status; 401 não registra nada', async () => {
    const a = fakeRpc()
    await trackCron('billing', async () => new Response('x', { status: 503 }), a.db)
    expect(a.calls[0].args).toMatchObject({ p_status: 'error', p_error: 'HTTP 503' })
    const b = fakeRpc()
    await trackCron('billing', async () => new Response('x', { status: 401 }), b.db)
    expect(b.calls).toHaveLength(0)
  })

  it('exceção do handler: registra erro e relança a MESMA exceção', async () => {
    const { db, calls } = fakeRpc()
    const boom = new Error('banco caiu')
    await expect(trackCron('flows', async () => { throw boom }, db)).rejects.toBe(boom)
    expect(calls[0].args).toMatchObject({ p_job: 'flows', p_expected_every_seconds: 300, p_status: 'error', p_error: 'banco caiu' })
  })

  it('falha ao registrar nunca derruba o cron: migration ausente = silêncio; erro/timeout = resposta intacta', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const missing = fakeRpc({ code: 'PGRST202', message: 'not found' })
    const r1 = new Response('ok', { status: 200 })
    expect(await trackCron('automations', async () => r1, missing.db)).toBe(r1)
    expect(console.error).not.toHaveBeenCalled()

    const hanging = { rpc: () => new Promise<never>(() => {}) }
    const t0 = Date.now()
    await recordCronHeartbeat('automations', { status: 'ok', durationMs: 5 }, hanging as never, 40)
    expect(Date.now() - t0).toBeLessThan(1_000) // o teto de espera impede o batimento de segurar o cron

    const throwing = { rpc: () => { throw new Error('rede') } }
    await expect(recordCronHeartbeat('automations', { status: 'ok', durationMs: 5 }, throwing as never)).resolves.toBeUndefined()
  })

  it('todo cron do docs/crons.md tem cadência definida', () => {
    expect(Object.keys(CRON_JOBS).sort()).toEqual([
      'automations', 'billing', 'channels_refresh_tokens', 'conversations_retry_assignment', 'disparador_exports', 'disparador_health',
      'disparador_imports', 'disparador_prepare', 'disparador_tick', 'flows', 'webhooks_out',
    ])
  })
})
