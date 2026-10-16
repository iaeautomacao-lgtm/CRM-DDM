import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { logAuditEvent } from '@/lib/audit/log-event'

export const dynamic = 'force-dynamic'

// Tarifas de IA da conta (migration 378, cost_rates com source='ai'; USD por 1 milhão de tokens). Append-only por vigência:
//  - GET (reports.view_all): vigências por effective_from desc + modelos já vistos/tarifados (sugestão para a tela);
//  - PUT (settings.account, admin/owner): cria a vigência; vigência FUTURA já existente é atualizada; vigência que já começou é imutável (409);
//    effective_from anterior ao 1º dia do mês atual (São Paulo) é recusada (não se reescreve o passado). Cada PUT é auditado (sku, data e valores).
const HEADERS = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' }
const SKU_PATTERN = /^(openai|gemini|claude|hermes):[a-z0-9][a-z0-9._:/-]{0,109}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_RATE = 100_000
const isMissing = (e: { code?: string } | null) => e?.code === 'PGRST202' || e?.code === '42883' || e?.code === '42P01' || e?.code === 'PGRST205'

type RateRow = {
  id?: string
  sku: string
  effective_from: string
  input_per_million: number | string | null
  cached_input_per_million: number | string | null
  output_per_million: number | string | null
}

function todaySaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
function view(r: RateRow, today: string) {
  return {
    sku: r.sku,
    currency: 'USD' as const,
    effective_from: r.effective_from,
    input_per_million: num(r.input_per_million),
    cached_input_per_million: num(r.cached_input_per_million),
    output_per_million: num(r.output_per_million),
    locked: r.effective_from <= today,
  }
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}
function rate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_RATE ? value : null
}
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: HEADERS })

export async function GET() {
  try {
    const ctx = await requirePermission('reports.view_all')
    const db = supabaseAdmin()
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const [rates, seen] = await Promise.all([
      db.from('cost_rates').select('sku,effective_from,input_per_million,cached_input_per_million,output_per_million')
        .eq('account_id', ctx.accountId).eq('source', 'ai').order('effective_from', { ascending: false }).limit(250),
      db.from('ai_token_usage').select('provider,model').eq('account_id', ctx.accountId).gte('occurred_at', since).limit(2000),
    ])
    const failure = rates.error ?? seen.error
    if (failure) {
      if (isMissing(failure)) return bad('Custos de IA indisponíveis: aplique a migration 378', 503)
      console.error('[costs/ai/rates] falha ao listar:', failure.code ?? 'unknown')
      return bad('Falha ao carregar as tarifas.', 500)
    }
    const today = todaySaoPaulo()
    const rows = (rates.data ?? []) as RateRow[]
    const skus = new Set<string>(rows.map((r) => r.sku))
    for (const u of (seen.data ?? []) as { provider: string; model: string }[]) skus.add(`${u.provider}:${u.model}`)
    return NextResponse.json({ rates: rows.map((r) => view(r, today)), skus: [...skus].sort() }, { headers: HEADERS })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requirePermission('settings.account')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Corpo inválido.')

    const sku = typeof body.sku === 'string' ? body.sku.trim().toLowerCase() : ''
    if (!SKU_PATTERN.test(sku)) return bad('Modelo inválido: use provedor:modelo (openai, gemini, claude ou hermes).')
    if (!validDate(body.effective_from)) return bad('Data de vigência inválida: use AAAA-MM-DD.')
    const effectiveFrom = body.effective_from
    const today = todaySaoPaulo()
    if (effectiveFrom < `${today.slice(0, 7)}-01`) return bad('A vigência não pode começar antes do mês atual: tarifas passadas não são reescritas.')

    const input = rate(body.input_per_million)
    const output = rate(body.output_per_million)
    const cached = body.cached_input_per_million === null || body.cached_input_per_million === undefined ? null : rate(body.cached_input_per_million)
    if (input === null || output === null || (body.cached_input_per_million != null && cached === null)) {
      return bad(`Os valores devem ser números de 0 a ${MAX_RATE}.`)
    }

    const db = supabaseAdmin()
    const found = await db.from('cost_rates').select('id,effective_from').eq('account_id', ctx.accountId).eq('source', 'ai').eq('sku', sku).eq('effective_from', effectiveFrom).limit(1)
    if (found.error) {
      if (isMissing(found.error)) return bad('Custos de IA indisponíveis: aplique a migration 378', 503)
      console.error('[costs/ai/rates] falha ao consultar:', found.error.code ?? 'unknown')
      return bad('Não foi possível salvar a tarifa.', 500)
    }
    const existing = ((found.data ?? []) as { id: string; effective_from: string }[])[0]
    const conflict = 'Já existe uma tarifa com essa vigência, que já começou e não pode ser alterada. Cadastre uma com data posterior.'
    if (existing && existing.effective_from <= today) return bad(conflict, 409)

    const values = { input_per_million: input, cached_input_per_million: cached, output_per_million: output }
    const saved = existing
      ? await db.from('cost_rates').update({ ...values, updated_at: new Date().toISOString() }).eq('id', existing.id).eq('account_id', ctx.accountId).select('id,sku,effective_from,input_per_million,cached_input_per_million,output_per_million').limit(1)
      : await db.from('cost_rates').insert({ account_id: ctx.accountId, source: 'ai', sku, effective_from: effectiveFrom, currency: 'USD', ...values })
          .select('id,sku,effective_from,input_per_million,cached_input_per_million,output_per_million').limit(1)
    if (saved.error) {
      if (saved.error.code === '23505') return bad(conflict, 409)
      console.error('[costs/ai/rates] falha ao salvar:', saved.error.code ?? 'unknown')
      return bad('Não foi possível salvar a tarifa.', 500)
    }
    const row = ((saved.data ?? []) as RateRow[])[0]
    if (!row?.id) return bad('Não foi possível salvar a tarifa.', 500)

    await logAuditEvent({
      accountId: ctx.accountId,
      eventType: existing ? 'updated' : 'created',
      resourceType: 'cost_rate',
      resourceId: row.id,
      resourceLabel: sku,
      action: 'cost_rate.saved',
      summary: `Tarifa de IA ${sku} com vigência em ${effectiveFrom}`,
      metadata: { sku, effective_from: effectiveFrom, ...values },
    })
    return NextResponse.json({ rate: view(row, today) }, { headers: HEADERS })
  } catch (err) {
    return toErrorResponse(err)
  }
}
