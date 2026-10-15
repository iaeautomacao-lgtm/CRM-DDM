import { describe, expect, it } from 'vitest'
import { costReportCsv, normalizeCostReport, reportTotals } from './report'

describe('monthly costs', () => {
  it('keeps USD and BRL separate and tracks uncovered values', () => {
    const report = normalizeCostReport('2026-10', {
      ai: [{sku:'openai:gpt-4.1', requests: 3, input_tokens: 100, output_tokens: 50, cached_input_tokens: 0, priced_usd: '0.005', unpriced: 1}],
      meta: [{sku:'BR:marketing',delivered:8,inferred:2,priced_brl:'2.4',unpriced:3}],
    }, [])
    expect(reportTotals(report)).toMatchObject({
      aiUsd: 0.005, metaBrl: 2.4, aiCalls:3, metaMessages:8, aiUnpriced:1, metaUnpriced:3, metaInferred:2,
    })
    const csv = costReportCsv(report)
    expect(csv).toContain('IA')
    expect(csv).toContain('Meta')
    expect(csv).toContain('2,40000000')
    expect(csv).not.toContain('NaN')
  })
  it('escapes spreadsheet formulas in model names', () => {
    const report = normalizeCostReport('2026-10',{ai:[{sku:'=malicious',requests:1}],meta:[]},[])
    expect(costReportCsv(report)).toContain("'=malicious")
  })
})
