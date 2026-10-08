import { ArrowDown, ArrowUp, Minus } from 'lucide-react'

interface MetricCardProps {
  title: string
  value: string
  delta?: {
    sign: number
    label: string
  }
  subtitle?: string
}

export function MetricCard({ title, value, delta, subtitle }: MetricCardProps) {
  return (
    <div className="min-w-0 rounded-lg border border-border/80 bg-card/35 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        {delta ? <DeltaBadge sign={delta.sign} label={delta.label} /> : null}
      </div>

      <p className="mt-4 text-[30px] font-semibold leading-none tracking-[-0.035em] tabular-nums text-foreground">
        {value}
      </p>

      {subtitle ? (
        <p className="mt-2 truncate text-[11px] text-muted-foreground/80">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaBadge({ sign, label }: { sign: number; label: string }) {
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus

  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted/70 px-2 py-1 text-[10px] font-medium text-muted-foreground">
      <Arrow className="h-3 w-3" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </span>
  )
}
