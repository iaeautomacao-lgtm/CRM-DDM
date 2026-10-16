// Relatório mensal de custo de IA (migration 378). ESTIMATIVA, não fatura: tarifa configurada × tokens informados pelo provedor.
// Sem tarifa para o item = "sem preço" (contagem), nunca zero. Nunca soma USD com BRL. O custo Meta NÃO está aqui: vem da 195
// (GET /api/disparador/desempenho/custo).
export interface AiCostRow {
  sku: string
  requests: number
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
  priced_usd: number
  unpriced: number
}
export interface AiCostRate {
  sku: string
  currency: 'USD'
  effective_from: string
  input_per_million: number | null
  cached_input_per_million: number | null
  output_per_million: number | null
}
export interface MonthlyAiCostReport {
  month: string
  /** Sempre true: o valor é estimativa (a tela deve dizer isso). */
  estimate: true
  currency: 'USD'
  ai: AiCostRow[]
  rates: AiCostRate[]
  totals: { requests: number; input_tokens: number; output_tokens: number; cached_input_tokens: number; priced_usd: number; unpriced: number }
  notice: string
}

export const COST_ESTIMATE_NOTICE =
  'Valores estimados: tarifa configurada × tokens informados pelo provedor. Não equivalem à fatura (impostos, câmbio, descontos e cotas gratuitas ficam de fora). Histórico anterior à instrumentação não existe.'

const finite = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : finite(v))

export function normalizeAiCostReport(month: string, rows: unknown, rates: unknown): MonthlyAiCostReport {
  const value = rows && typeof rows === 'object' && !Array.isArray(rows) ? (rows as Record<string, unknown>) : {}
  const ai = (Array.isArray(value.ai) ? value.ai : []).map((r: Record<string, unknown>) => ({
    sku: String(r.sku ?? 'unknown'),
    requests: finite(r.requests),
    input_tokens: finite(r.input_tokens),
    output_tokens: finite(r.output_tokens),
    cached_input_tokens: finite(r.cached_input_tokens),
    priced_usd: finite(r.priced_usd),
    unpriced: finite(r.unpriced),
  }))
  const rateRows = (Array.isArray(rates) ? rates : []).map((r: Record<string, unknown>) => ({
    sku: String(r.sku ?? ''),
    currency: 'USD' as const,
    effective_from: String(r.effective_from ?? ''),
    input_per_million: nullableNumber(r.input_per_million),
    cached_input_per_million: nullableNumber(r.cached_input_per_million),
    output_per_million: nullableNumber(r.output_per_million),
  }))
  const sum = (pick: (r: AiCostRow) => number) => ai.reduce((s, r) => s + pick(r), 0)
  return {
    month,
    estimate: true,
    currency: 'USD',
    ai,
    rates: rateRows,
    totals: {
      requests: sum((r) => r.requests),
      input_tokens: sum((r) => r.input_tokens),
      output_tokens: sum((r) => r.output_tokens),
      cached_input_tokens: sum((r) => r.cached_input_tokens),
      priced_usd: sum((r) => r.priced_usd),
      unpriced: sum((r) => r.unpriced),
    },
    notice: COST_ESTIMATE_NOTICE,
  }
}

/** CSV para Excel (separador ;), com proteção contra injeção de fórmula nas células de texto. */
function csvCell(value: unknown): string {
  const raw = String(value ?? '')
  const safe = /^[\t\r\n\s]*[=+@-]/.test(raw) ? "'" + raw : raw
  return '"' + safe.replace(/"/g, '""') + '"'
}

export function aiCostReportCsv(report: MonthlyAiCostReport): string {
  const cols = ['mes', 'item', 'moeda', 'chamadas', 'valor_estimado', 'sem_tarifa', 'tokens_entrada', 'tokens_saida', 'tokens_cache']
  const lines = [cols.map(csvCell).join(';')]
  for (const r of report.ai) {
    lines.push([report.month, r.sku, 'USD', r.requests, r.priced_usd.toFixed(8).replace('.', ','), r.unpriced, r.input_tokens, r.output_tokens, r.cached_input_tokens].map(csvCell).join(';'))
  }
  lines.push([report.month, 'Observacao: ' + report.notice, '', '', '', '', '', '', ''].map(csvCell).join(';'))
  return '﻿' + lines.join('\r\n') + '\r\n'
}
