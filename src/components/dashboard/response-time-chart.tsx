"use client"

import { Clock } from 'lucide-react'
import { DOW_SHORT_MON_FIRST } from '@/lib/dashboard/date-utils'
import type { ResponseTimeSummary } from '@/lib/dashboard/types'
import { BarChart } from '@/components/tremor/bar-chart'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ResponseTimeChartProps {
  data: ResponseTimeSummary | null
  loading: boolean
  /** Minutes. Surfaced as a "target" pill in the header. The
   *  hand-rolled SVG version drew this as a horizontal dashed
   *  line on the chart; Tremor BarChart doesn't expose Recharts
   *  primitives, so we promote it to the header for now. A
   *  follow-up can introduce an overlay or extend the vendored
   *  BarChart with a `referenceLines` prop. */
  thresholdMinutes?: number
}

// Single category, single colour — the data is "average minutes
// per weekday". Tremor expects categories as the second tuple in
// the row object, so we shape the buckets into
// `{ day: 'Mon', 'Avg minutes': 4.2 }` rows below.
const CATEGORY = 'Média (min)'

export function ResponseTimeChart({
  data,
  loading,
  thresholdMinutes = 5,
}: ResponseTimeChartProps) {
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false

  // Map buckets → Tremor rows. Null `avgMinutes` (no samples)
  // collapses to 0; the chart will render an empty slot for it.
  // We attach `samples` on the row so a future customTooltip can
  // surface "no samples" copy without losing the data shape.
  const chartData =
    data?.buckets.map((b, i) => ({
      day: DOW_SHORT_MON_FIRST[i],
      [CATEGORY]: b.avgMinutes ?? 0,
      samples: b.samples,
    })) ?? []

  return (
    <section className="">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Tempo Médio de Primeira Resposta
          </h2>
          
        </div>
        {data && (data.thisWeekAvg != null || data.lastWeekAvg != null) ? (
          <div className="flex items-center gap-4 rounded-lg border border-border/80 bg-card/25 px-4 py-3">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Média atual
              </p>
              <p className="mt-1 text-xl font-semibold leading-none tracking-[-0.03em] tabular-nums text-foreground">
                {fmt(data.thisWeekAvg)}
              </p>
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="text-[11px] text-muted-foreground">
              <p>Meta <span className="font-medium tabular-nums text-foreground">{thresholdMinutes}m</span></p>
              <p className="mt-1">Anterior <span className="tabular-nums">{fmt(data.lastWeekAvg)}</span></p>
            </div>
          </div>
        ) : null}
      </header>

      <div className="mt-4">
        {loading || !data ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !hasData ? (
          <EmptyState
            icon={Clock}
            title="Nenhuma resposta registrada ainda"
            hint="Este gráfico é preenchido conforme você responde às mensagens dos clientes."
          />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[CATEGORY]}
            // 'ddmOrange' maps to the DDM brand primary (#FF5706) — see
            // chart-colors.ts.
            colors={['ddmOrange']}
            valueFormatter={(value) => `${value.toFixed(1)}m`}
            showLegend={false}
            borderRadius={2}
            // Explicit floor at 0 + no fixed yAxisWidth override — let
            // Tremor size the axis to whatever tick labels it computes,
            // instead of a width tuned for a narrower label that could
            // clip/duplicate ticks (e.g. "0.1m" appearing twice).
            minValue={0}
            // Compact height so the chart sits well inside the card
            // without dominating the row alongside the donut + activity feed.
            className="h-[260px]"
          />
        )}
      </div>
    </section>
  )
}

function fmt(mins: number | null): string {
  if (mins == null) return '—'
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))}s`
  if (mins < 60) return `${mins.toFixed(1)}m`
  return `${(mins / 60).toFixed(1)}h`
}
