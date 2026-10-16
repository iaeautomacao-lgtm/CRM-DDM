import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { aiCostReportCsv, normalizeAiCostReport } from '@/lib/costs/report'
import { CSV_BOM } from '@/lib/security/csv-safe'

export const dynamic = 'force-dynamic'

// Custo ESTIMADO de IA do mês (migration 378): tokens informados pelo provedor × tarifa configurada da conta. Só leitura; sempre escopado pela conta
// de quem pede. O custo Meta não está aqui (195: /api/disparador/desempenho/custo). ?month=AAAA-MM (padrão: mês atual, fuso de São Paulo); ?format=csv.
const MONTH_PATTERN = /^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/
const HEADERS = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' }
const isMissing = (e: { code?: string } | null) => e?.code === 'PGRST202' || e?.code === '42883' || e?.code === '42P01' || e?.code === 'PGRST205'

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
  return `${parts.find((p) => p.type === 'year')?.value ?? '2026'}-${parts.find((p) => p.type === 'month')?.value ?? '01'}`
}

export async function GET(request: Request) {
  try {
    const ctx = await requirePermission('reports.view_all')
    const url = new URL(request.url)
    const raw = url.searchParams.get('month')
    const month = raw === null ? currentMonth() : MONTH_PATTERN.test(raw) ? raw : null
    if (!month) return NextResponse.json({ error: 'Mês inválido: use AAAA-MM' }, { status: 400, headers: HEADERS })

    const db = supabaseAdmin()
    const [summary, rates] = await Promise.all([
      db.rpc('get_monthly_ai_cost_report', { p_account_id: ctx.accountId, p_month: `${month}-01` }),
      db
        .from('cost_rates')
        .select('sku,effective_from,input_per_million,cached_input_per_million,output_per_million')
        .eq('account_id', ctx.accountId)
        .eq('source', 'ai')
        .order('effective_from', { ascending: false })
        .limit(250),
    ])
    const failure = summary.error ?? rates.error
    if (failure) {
      if (isMissing(failure)) return NextResponse.json({ error: 'Custos de IA indisponíveis: aplique a migration 378' }, { status: 503, headers: HEADERS })
      console.error('[costs/ai] falha ao carregar o relatório:', failure.code ?? 'unknown')
      return NextResponse.json({ error: 'Falha ao carregar os custos de IA.' }, { status: 500, headers: HEADERS })
    }

    const report = normalizeAiCostReport(month, summary.data, rates.data)
    if (url.searchParams.get('format') === 'csv') {
      return new Response(CSV_BOM + aiCostReportCsv(report), {
        status: 200,
        headers: { ...HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="custos-ia-${month}.csv"` },
      })
    }
    return NextResponse.json(report, { headers: HEADERS })
  } catch (err) {
    return toErrorResponse(err)
  }
}
