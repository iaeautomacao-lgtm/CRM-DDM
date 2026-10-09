import Link from 'next/link'
import { ArrowDown, ArrowUp, ChevronRight, Minus } from 'lucide-react'
import { CountUp } from '@/components/motion/count-up'
import { Skeleton } from '@/components/ui/skeleton'
import { deltaTone, formatDelta } from '@/lib/dashboard/view'
import { cn } from '@/lib/utils'

/**
 * KPI do Dashboard (protótipo DDM): cartão clicável com título, número
 * grande que conta até o valor real, variação colorida pela leitura
 * (subir é bom ou ruim) e uma nota curta.
 */
export function MetricCard({
  title,
  value,
  delta,
  higherIsBetter,
  note,
  href,
  loading = false,
}: {
  title: string
  value: number
  delta: number
  higherIsBetter: boolean
  note: string
  href: string
  loading?: boolean
}) {
  const tone = deltaTone(delta, higherIsBetter)
  const Arrow = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus
  const toneClass =
    tone === 'up-good' || tone === 'down-good'
      ? 'text-success'
      : tone === 'up-bad' || tone === 'down-bad'
        ? 'text-danger'
        : 'text-muted-foreground'

  return (
    <Link
      href={href}
      className="group flex flex-col gap-3.5 rounded-[10px] border border-border bg-card px-[18px] py-4 text-left transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-[0_4px_14px_rgba(0,0,0,.12)] focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-foreground-2">{title}</span>
        <ChevronRight
          className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
      <span className="flex min-h-[30px] flex-wrap items-baseline gap-2.5">
        {loading ? (
          <Skeleton className="h-[30px] w-[88px]" />
        ) : (
          <>
            <CountUp
              value={value}
              className="text-[30px] font-semibold leading-none tracking-[-0.03em] text-foreground"
            />
            <span className={cn('inline-flex items-center gap-[3px] text-xs font-semibold tabular-nums', toneClass)}>
              <Arrow className="size-3" aria-hidden="true" />
              {formatDelta(delta)}
            </span>
          </>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </Link>
  )
}
