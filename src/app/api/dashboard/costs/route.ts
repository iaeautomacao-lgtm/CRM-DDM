import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { costReportCsv, normalizeCostReport } from '@/lib/billing/report'

const MONTH_PATTERN = /^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/
const SKU_PATTERN = /^[a-z0-9][a-z0-9._:/-]{1,127}$/
const META_SKU_PATTERN = /^BR:(marketing|utility|authentication|service)$/

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit' }).formatToParts(new Date())
  return (parts.find(p=>p.type==='year')?.value ?? '2026')+'-'+(parts.find(p=>p.type==='month')?.value ?? '01')
}
function monthOf(value: string | null): string | null {
  if (value === null) return currentMonth()
  return MONTH_PATTERN.test(value) ? value : null
}
function validNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) return null
  return value
}
const JSON_HEADERS = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options':'nosniff' }

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const url = new URL(request.url)
    const month = monthOf(url.searchParams.get('month'))
    if (!month) return NextResponse.json({ error: 'Mês inválido: use AAAA-MM' }, { status: 400 })
    const db = supabaseAdmin()
    const [summary, rates] = await Promise.all([
      db.rpc('get_monthly_cost_report', { p_account_id: ctx.accountId, p_month: month+'-01' }),
      db.from('cost_rates').select('source,sku,effective_from,currency,input_per_million,cached_input_per_million,output_per_million,per_message')
        .eq('account_id', ctx.accountId).order('effective_from', { ascending:false }).limit(250),
    ])
    if (summary.error || rates.error) {
      console.error('[dashboard/costs] report failed:', summary.error?.code ?? rates.error?.code ?? 'unknown')
      return NextResponse.json({ error: 'Falha ao carregar custos. Confira a migration 377.' }, { status:500, headers:JSON_HEADERS })
    }
    const report = normalizeCostReport(month, summary.data, rates.data)
    if (url.searchParams.get('format') === 'csv') {
      return new Response(costReportCsv(report), {
        status:200, headers: {
          ...JSON_HEADERS,
          'Content-Type':'text/csv; charset=utf-8',
          'Content-Disposition':'attachment; filename="custos-crm-'+month+'.csv"',
        },
      })
    }
    return NextResponse.json(report, { headers: JSON_HEADERS })
  } catch (err) { return toErrorResponse(err) }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return NextResponse.json({error:'Corpo inválido'},{status:400})
    const source = body.source
    const sku = body.sku
    const validFrom = body.effective_from
    if ((source !== 'ai' && source !== 'meta') || typeof sku !== 'string' || !SKU_PATTERN.test(sku) ||
        typeof validFrom !== 'string' || !MONTH_PATTERN.test(validFrom.slice(0,7)) || validFrom !== validFrom.slice(0,7)+'-01') {
      return NextResponse.json({error:'Origem, item ou competência inválida'},{status:400})
    }
    const isAi = source === 'ai'
    if ((!isAi && !META_SKU_PATTERN.test(sku)) || (isAi && !/^(openai|gemini|claude|hermes):[a-z0-9][a-z0-9._:/-]{0,110}$/i.test(sku))) {
      return NextResponse.json({ error:'Item de tarifa inválido' },{status:400})
    }
    const input = validNumber(body.input_per_million)
    const output = validNumber(body.output_per_million)
    const cached = body.cached_input_per_million === null ? null : validNumber(body.cached_input_per_million)
    const perMessage = validNumber(body.per_message)
    if ((isAi && (input===null || output===null || (body.cached_input_per_million !== null && cached===null))) ||
        (!isAi && perMessage===null)) {
      return NextResponse.json({error:'Os valores devem ser números não negativos (máximo 100.000)'},{status:400})
    }
    const row = {
      account_id:ctx.accountId, source, sku, effective_from:validFrom,
      currency:isAi?'USD':'BRL',
      input_per_million:isAi?input:null,
      cached_input_per_million:isAi?cached:null,
      output_per_million:isAi?output:null,
      per_message:isAi?null:perMessage,
      updated_at:new Date().toISOString(),
    }
    const {error} = await supabaseAdmin().from('cost_rates').upsert(row, {onConflict:'account_id,source,sku,effective_from'})
    if (error) {
      console.error('[dashboard/costs] rate save failed:', error.code)
      return NextResponse.json({error:'Não foi possível salvar a tarifa'},{status:500})
    }
    return NextResponse.json({ok:true},{headers:JSON_HEADERS})
  } catch(err) { return toErrorResponse(err) }
}
