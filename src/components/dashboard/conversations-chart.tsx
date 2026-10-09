"use client"

import { useState, type KeyboardEvent } from 'react'
import { MessageSquare } from 'lucide-react'
import type { ConversationsSeriesPoint } from '@/lib/dashboard/types'
import { dayKeyLabel, niceAxisTop, xLabelIndexes } from '@/lib/dashboard/view'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { DashCard, Segmented, Swatch } from './dash-card'
import { EmptyState } from './empty-state'

export type RangeDays = 7 | 30 | 90

const RANGES: ReadonlyArray<{ value: RangeDays; label: string }> = [
  { value: 7, label: '7 dias' },
  { value: 30, label: '30 dias' },
  { value: 90, label: '90 dias' },
]

// Série de entrada (cliente) em azul, saída na cor da marca — como no
// protótipo. O azul muda com o modo claro/escuro.
const SERIES_IN = 'bg-[#5B8DEF] [html[data-mode=light]_&]:bg-[#3B6FD8]'

const fmt = (n: number) => n.toLocaleString('pt-BR')

/**
 * "Movimento de conversas": barras duplas por dia (entrada × saída) com
 * período 7/30/90, grade tracejada e tooltip ao passar o mouse ou ao
 * navegar com as setas do teclado.
 */
export function ConversationsChart({
  series,
  loading,
  range,
  onRangeChange,
}: {
  series: Record<RangeDays, ConversationsSeriesPoint[] | null>
  loading: boolean
  range: RangeDays
  onRangeChange: (r: RangeDays) => void
}) {
  const [hover, setHover] = useState(-1)
  const data = series[range]
  const ready = !loading && data !== null

  const totIn = data?.reduce((a, p) => a + p.incoming, 0) ?? 0
  const totOut = data?.reduce((a, p) => a + p.outgoing, 0) ?? 0
  const hasData = totIn + totOut > 0

  const changeRange = (r: RangeDays) => {
    setHover(-1)
    onRangeChange(r)
  }

  return (
    <DashCard
      title="Movimento de conversas"
      label="Conversas por dia"
      className="flex-[2_1_560px]"
      subtitle={
        ready
          ? `${fmt(totIn)} recebidas · ${fmt(totOut)} enviadas nos últimos ${range} dias`
          : 'Carregando…'
      }
      action={<Segmented ariaLabel="Período" options={RANGES} value={range} onChange={changeRange} />}
    >
      {!ready || !data ? (
        <Skeleton className="h-[200px] w-full" />
      ) : !hasData ? (
        <EmptyState
          icon={MessageSquare}
          className="min-h-[200px]"
          title="Nenhuma mensagem no período"
          hint="O gráfico é preenchido conforme as conversas acontecem."
        />
      ) : (
        <Bars data={data} hover={hover} setHover={setHover} range={range} />
      )}
      <div className="flex flex-wrap gap-4 text-xs text-foreground-2">
        <span className="inline-flex items-center gap-1.5">
          <Swatch className={SERIES_IN} />
          Entrada (cliente)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch className="bg-primary" />
          Saída (equipe e automação)
        </span>
      </div>
    </DashCard>
  )
}

function Bars({
  data,
  hover,
  setHover,
  range,
}: {
  data: ConversationsSeriesPoint[]
  hover: number
  setHover: (i: number) => void
  range: RangeDays
}) {
  const max = Math.max(...data.map((p) => Math.max(p.incoming, p.outgoing)))
  const top = niceAxisTop(max)
  const ticks = [top, top * 0.75, top * 0.5, top * 0.25, 0]
  const labels = xLabelIndexes(data.length)
  const gap = range === 90 ? 1 : range === 30 ? 3 : 14
  const hp = hover >= 0 ? data[hover] : null
  const tipLeft = hover >= 0 ? (hover + 0.5) / data.length : 0

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHover(Math.min(data.length - 1, hover + 1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHover(hover <= 0 ? 0 : hover - 1)
    } else if (e.key === 'Escape') {
      setHover(-1)
    }
  }

  return (
    <div className="relative flex h-[200px] flex-col">
      <div className="pointer-events-none absolute inset-[0_0_22px_36px] flex flex-col justify-between">
        {ticks.map((t) => (
          <div key={t} className="relative h-0 border-t border-dashed border-border">
            <span className="absolute right-[calc(100%+8px)] top-[-7px] text-[11px] tabular-nums text-muted-foreground">
              {fmt(Math.round(t))}
            </span>
          </div>
        ))}
      </div>
      <div
        role="img"
        tabIndex={0}
        aria-label="Mensagens por dia. Use as setas para ver cada dia."
        onKeyDown={onKey}
        onMouseLeave={() => setHover(-1)}
        onBlur={() => setHover(-1)}
        className="absolute inset-[0_0_22px_36px] flex items-end rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        style={{ gap }}
      >
        {data.map((p, i) => {
          const op = hover === -1 || hover === i ? 1 : 0.35
          return (
            <div
              key={p.day}
              onMouseEnter={() => setHover(i)}
              className={cn(
                'flex h-full min-w-0 flex-1 items-end justify-center gap-px rounded-[3px]',
                hover === i && 'bg-surface-hover',
              )}
            >
              <span
                className={cn('max-w-[10px] flex-1 origin-bottom animate-ddm-col rounded-t-[2px] transition-[height,opacity] duration-300', SERIES_IN)}
                style={{ height: `${(p.incoming / top) * 100}%`, opacity: op }}
              />
              <span
                className="max-w-[10px] flex-1 origin-bottom animate-ddm-col rounded-t-[2px] bg-primary transition-[height,opacity] duration-300"
                style={{ height: `${(p.outgoing / top) * 100}%`, opacity: op }}
              />
            </div>
          )
        })}
      </div>
      <div className="absolute bottom-0 left-9 right-0 flex h-4 justify-between text-[11px] tabular-nums text-muted-foreground">
        {labels.map((i) => (
          <span key={i}>{dayKeyLabel(data[i].day)}</span>
        ))}
      </div>
      {hp ? (
        <div
          role="status"
          className="pointer-events-none absolute top-1 z-[5] min-w-[150px] animate-ddm-fade rounded-lg border border-border bg-popover px-3 py-2.5 shadow-overlay"
          style={{
            left: `calc(36px + (100% - 36px) * ${tipLeft})`,
            transform: `translateX(${tipLeft > 0.7 ? '-105%' : '8px'})`,
          }}
        >
          <p className="mb-1.5 text-xs font-semibold text-foreground">{dayKeyLabel(hp.day)}</p>
          <p className="flex items-center gap-1.5 text-xs text-foreground-2">
            <Swatch className={SERIES_IN} />
            Entrada
            <span className="ml-auto font-semibold tabular-nums text-foreground">{fmt(hp.incoming)}</span>
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-foreground-2">
            <Swatch className="bg-primary" />
            Saída
            <span className="ml-auto font-semibold tabular-nums text-foreground">{fmt(hp.outgoing)}</span>
          </p>
        </div>
      ) : null}
    </div>
  )
}
