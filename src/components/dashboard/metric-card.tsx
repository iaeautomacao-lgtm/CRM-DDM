import { ArrowDown, ArrowUp, Minus } from 'lucide-react'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "1.250"). */
  value: string
  delta?: {
    /** Positive / negative / zero controls only the direction arrow. */
    sign: number
    /** Pre-formatted comparison label. */
    label: string
  }
  subtitle?: string
}

/**
 * Compact operational metric used inside the Dashboard KPI strip.
 *
 * The container owns the border/surface. This component deliberately
 * avoids icon badges, shadows and semantic delta colours: a positive
 * delta is not inherently good (for example, more pending conversations).
 */
export function MetricCard({ title, value, delta, subtitle }: MetricCardProps) {
  return (
    <div className="min-w-0 px-5 py-4 lg:px-6 lg:py-5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-2 truncate text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus

  return (
    <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate tabular-nums">{label}</span>
    </div>
  )
}
