import { ArrowDown, ArrowUp, Clock, Minus } from 'lucide-react'
import { DOW_SHORT_MON_FIRST } from '@/lib/dashboard/date-utils'
import type { ResponseTimeSummary } from '@/lib/dashboard/types'
import { deltaTone, formatMinutes } from '@/lib/dashboard/view'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { DashCard } from './dash-card'
import { EmptyState } from './empty-state'

/**
 * "Tempo de primeira resposta": média da semana, variação contra a semana
 * anterior (descer é bom) e barras por dia da semana com a linha da meta.
 * Dias acima da meta ficam em vermelho.
 */
export function ResponseTimeChart({
  data,
  loading,
  thresholdMinutes = 5,
}: {
  data: ResponseTimeSummary | null
  loading: boolean
  /** Meta em minutos (linha tracejada). */
  thresholdMinutes?: number
}) {
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false

  return (
    <DashCard
      title="Tempo de primeira resposta"
      subtitle={`Média da semana · meta ${thresholdMinutes} min`}
      className="flex-[1_1_300px]"
    >
      {loading || !data ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-[30px] w-32" />
          <Skeleton className="h-[140px] w-full" />
        </div>
      ) : !hasData ? (
        <EmptyState
          icon={Clock}
          title="Nenhuma resposta registrada ainda"
          hint="Este gráfico é preenchido conforme a equipe responde às mensagens dos clientes."
        />
      ) : (
        <Body data={data} meta={thresholdMinutes} />
      )}
    </DashCard>
  )
}

function Body({ data, meta }: { data: ResponseTimeSummary; meta: number }) {
  const values = data.buckets.map((b) => b.avgMinutes ?? 0)
  // Escala com folga acima da meta e do maior valor, para a linha caber.
  const scaleMax = Math.max(meta * 1.4, ...values) * 1.1
  const metaPct = (meta / scaleMax) * 100
  const delta =
    data.thisWeekAvg != null && data.lastWeekAvg != null ? data.thisWeekAvg - data.lastWeekAvg : null
  const tone = delta == null ? 'flat' : deltaTone(delta, false)
  const Arrow = delta == null || delta === 0 ? Minus : delta > 0 ? ArrowUp : ArrowDown

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className="text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-foreground">
          {formatMinutes(data.thisWeekAvg)}
        </span>
        {delta != null && (
          <span
            className={cn(
              'inline-flex items-center gap-[3px] text-xs font-semibold tabular-nums',
              tone === 'down-good' ? 'text-success' : tone === 'up-bad' ? 'text-danger' : 'text-muted-foreground',
            )}
          >
            <Arrow className="size-3" aria-hidden="true" />
            {formatMinutes(Math.abs(delta))} vs semana anterior
          </span>
        )}
      </div>
      <div className="relative flex min-h-[120px] flex-1 items-end gap-2 pb-5">
        <div
          className="absolute inset-x-0 border-t border-dashed border-danger"
          style={{ bottom: `calc(20px + (100% - 20px) * ${metaPct / 100})` }}
        >
          <span className="absolute right-0 top-[-17px] text-[11px] font-semibold text-danger">
            Meta {meta} min
          </span>
        </div>
        {data.buckets.map((b, i) => {
          const v = b.avgMinutes
          const over = v != null && v > meta
          return (
            <div
              key={b.dow}
              title={`${DOW_SHORT_MON_FIRST[i]}: ${v == null ? 'sem respostas' : formatMinutes(v)}`}
              className="relative flex h-full flex-1 flex-col items-center justify-end"
            >
              <span
                className={cn(
                  'w-full max-w-[26px] origin-bottom animate-ddm-col rounded-t-[3px] transition-[height] duration-300',
                  v == null ? 'bg-surface-3' : over ? 'bg-danger' : 'bg-muted-foreground',
                )}
                style={{ height: v == null ? '3px' : `${(v / scaleMax) * 100}%` }}
              />
              <span className="absolute bottom-[-18px] text-[11px] text-muted-foreground">
                {DOW_SHORT_MON_FIRST[i]}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
