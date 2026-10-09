"use client"

import { useState } from 'react'
import { Trophy } from 'lucide-react'
import type { AiAnalyticsData } from '@/lib/dashboard/types'
import { CountUp } from '@/components/motion/count-up'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { DashCard, Segmented } from './dash-card'
import { EmptyState } from './empty-state'

type RankMode = 'valor' | 'acordos'
const RANK_MODES: ReadonlyArray<{ value: RankMode; label: string }> = [
  { value: 'valor', label: 'Valor' },
  { value: 'acordos', label: 'Acordos' },
]
const TOP = 5

const brl = (n: number) =>
  Math.round(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })

/**
 * "Recuperação financeira": totais dos negócios dos funis (ganhos, em
 * aberto, ticket médio) e ranking dos atendentes por valor ou por
 * quantidade de acordos ganhos.
 */
export function FinancialPerformance({ data, loading }: { data: AiAnalyticsData | null; loading: boolean }) {
  const [mode, setMode] = useState<RankMode>('valor')
  const [showAll, setShowAll] = useState(false)
  const fin = data?.financials

  return (
    <DashCard
      title="Recuperação financeira"
      subtitle="Negócios registrados nos funis"
      className="flex-[2_1_560px]"
    >
      {loading || !fin ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-[76px] w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-px overflow-hidden rounded-lg border border-border bg-border">
            {[
              { label: 'Acordos ganhos', value: fin.totalWonValue },
              { label: 'Em negociação', value: fin.totalOpenValue },
              { label: 'Ticket médio', value: fin.ticketMedio },
            ].map((f) => (
              <div key={f.label} className="flex flex-col gap-1.5 bg-card px-4 py-3.5">
                <span className="text-[12.5px] text-foreground-2">{f.label}</span>
                <CountUp
                  value={f.value}
                  format={brl}
                  className="whitespace-nowrap text-[22px] font-semibold tracking-[-0.02em] text-foreground"
                />
              </div>
            ))}
          </div>
          <Ranking
            operators={fin.operators}
            mode={mode}
            setMode={setMode}
            showAll={showAll}
            setShowAll={setShowAll}
          />
        </>
      )}
    </DashCard>
  )
}

function Ranking({
  operators,
  mode,
  setMode,
  showAll,
  setShowAll,
}: {
  operators: NonNullable<AiAnalyticsData['financials']>['operators']
  mode: RankMode
  setMode: (m: RankMode) => void
  showAll: boolean
  setShowAll: (v: boolean) => void
}) {
  const byVal = mode === 'valor'
  const sorted = operators
    .slice()
    .sort((a, b) => (byVal ? b.totalWon - a.totalWon : b.dealCount - a.dealCount))
  const visible = showAll ? sorted : sorted.slice(0, TOP)
  const max = sorted.length ? (byVal ? sorted[0].totalWon : sorted[0].dealCount) : 0

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <h4 className="m-0 font-sans text-[13px] font-semibold text-foreground">Ranking de cobradores</h4>
        {sorted.length > 0 && (
          <Segmented size="sm" ariaLabel="Ordenar ranking por" options={RANK_MODES} value={mode} onChange={setMode} />
        )}
      </div>
      {sorted.length === 0 ? (
        <EmptyState icon={Trophy} className="mt-2 min-h-28" title="Nenhum acordo ganho registrado" />
      ) : (
        <ol className="ddm-stagger m-0 flex list-none flex-col p-0">
          {visible.map((op, i) => {
            const v = byVal ? op.totalWon : op.dealCount
            return (
              <li
                key={op.userId}
                className="grid h-9 grid-cols-[18px_minmax(0,1fr)_110px] items-center gap-3 sm:grid-cols-[20px_160px_minmax(0,1fr)_120px]"
              >
                <span className="text-xs font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="truncate text-[13px] text-foreground">{op.userName}</span>
                <span className="hidden h-1.5 overflow-hidden rounded-full bg-surface-3 sm:block">
                  <span
                    className={cn(
                      'block h-full origin-left animate-ddm-bar rounded-full transition-[width] duration-500',
                      i === 0 ? 'bg-primary' : 'bg-muted-foreground',
                    )}
                    style={{ width: `${max > 0 ? (v / max) * 100 : 0}%` }}
                  />
                </span>
                <span className="text-right text-[13px] font-semibold tabular-nums text-foreground">
                  {byVal ? brl(op.totalWon) : `${op.dealCount} acordo${op.dealCount === 1 ? '' : 's'}`}
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {sorted.length > TOP && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mt-1 self-start text-[12.5px] font-semibold text-primary-text hover:underline"
        >
          {showAll ? 'Mostrar menos' : `Ver todos (${sorted.length})`}
        </button>
      )}
    </div>
  )
}
