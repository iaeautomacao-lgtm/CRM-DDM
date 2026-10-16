export interface AiCostRow {
  sku: string
  requests: number
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
  priced_usd: number
  unpriced: number
}
export interface MetaCostRow {
  sku: string
  delivered: number
  inferred: number
  priced_brl: number
  unpriced: number
}
export interface CostRate {
  source: 'ai' | 'meta'
  sku: string
  currency: 'USD' | 'BRL'
  effective_from: string
  input_per_million: number | null
  cached_input_per_million: number | null
  output_per_million: number | null
  per_message: number | null
}
export interface MonthlyCostReport {
  month: string
  ai: AiCostRow[]
  meta: MetaCostRow[]
  rates: CostRate[]
}
const finite = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
export function normalizeCostReport(month: string, rows: unknown, rates: unknown): MonthlyCostReport {
  const value = rows && typeof rows === 'object' && !Array.isArray(rows) ? rows as Record<string, unknown> : {}
  const ai = Array.isArray(value.ai) ? value.ai : []
  const meta = Array.isArray(value.meta) ? value.meta : []
  return {
    month,
    ai: ai.map((r: Record<string, unknown>) => ({
      sku: String(r.sku ?? 'unknown'),
      requests: finite(r.requests), input_tokens: finite(r.input_tokens),
      output_tokens: finite(r.output_tokens), cached_input_tokens: finite(r.cached_input_tokens),
      priced_usd: finite(r.priced_usd), unpriced: finite(r.unpriced),
    })),
    meta: meta.map((r: Record<string, unknown>) => ({
      sku: String(r.sku ?? 'unknown'), delivered: finite(r.delivered),
      inferred: finite(r.inferred), priced_brl: finite(r.priced_brl), unpriced: finite(r.unpriced),
    })),
    rates: Array.isArray(rates) ? rates as CostRate[] : [],
  }
}
export function reportTotals(report: MonthlyCostReport) {
  return {
    aiUsd: report.ai.reduce((s, x) => s + x.priced_usd, 0),
    metaBrl: report.meta.reduce((s, x) => s + x.priced_brl, 0),
    aiCalls: report.ai.reduce((s, x) => s + x.requests, 0),
    metaMessages: report.meta.reduce((s, x) => s + x.delivered, 0),
    aiUnpriced: report.ai.reduce((s, x) => s + x.unpriced, 0),
    metaUnpriced: report.meta.reduce((s, x) => s + x.unpriced, 0),
    metaInferred: report.meta.reduce((s, x) => s + x.inferred, 0),
    inputTokens: report.ai.reduce((s, x) => s + x.input_tokens, 0),
    outputTokens: report.ai.reduce((s, x) => s + x.output_tokens, 0),
  }
}
/** Excel-friendly semicolon CSV; strings guarded against formula injection. */
function csvCell(value: unknown): string {
  const raw = String(value ?? '')
  const safe = /^[\t\r\n\s]*[=+@-]/.test(raw) ? "'" + raw : raw
  return '"' + safe.replace(/"/g, '""') + '"'
}
export function costReportCsv(report: MonthlyCostReport): string {
  const cols = ['mes','origem','item','moeda','quantidade','valor_estimado','sem_tarifa','historicos_inferidos','tokens_entrada','tokens_saida','tokens_cache']
  const lines = [cols.map(csvCell).join(';')]
  for (const row of report.ai) {
    lines.push([report.month,'IA',row.sku,'USD',row.requests,row.priced_usd.toFixed(8).replace('.',','),row.unpriced,0,row.input_tokens,row.output_tokens,row.cached_input_tokens].map(csvCell).join(';'))
  }
  for (const row of report.meta) {
    lines.push([report.month,'Meta',row.sku,'BRL',row.delivered,row.priced_brl.toFixed(8).replace('.',','),row.unpriced,row.inferred,0,0,0].map(csvCell).join(';'))
  }
  // Never sum USD with BRL or treat missing prices as zero total.
  lines.push([report.month,'Observacao','Custo estimado. Compare com faturas e ajuste tarifas por vigencia. Historico de IA anterior a instrumentacao nao pode ser reconstruido.','','','','','','','',''].map(csvCell).join(';'))
  return '\ufeff'+lines.join('\r\n')+'\r\n'
}
