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
      className="group flex flex-col gap-3.5 rounded-card bg-card p-5 text-left shadow-sm transition-[transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring dark:border dark:border-border"
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-muted-foreground">{title}</span>
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
              className="font-heading text-[28px] font-bold leading-none tracking-[-0.02em] text-foreground"
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
