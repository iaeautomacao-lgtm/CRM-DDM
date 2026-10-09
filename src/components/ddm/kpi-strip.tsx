import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { InfoHint } from './info-hint'

export type KpiTone = 'default' | 'ok' | 'warn' | 'bad' | 'muted'

export interface KpiItem {
  label: string
  /** Valor real já formatado (ou <CountUp/>). */
  value: ReactNode
  /** Texto curto ao lado do valor (ex.: "+12 hoje", "100 mil+"). */
  note?: ReactNode
  noteTone?: KpiTone
  /** Explicação do número: vira um "i" ao lado do rótulo (abre com clique, teclado e toque). */
  info?: ReactNode
  /** Clicável: a célula vira um botão (ex.: filtrar a lista por esse status). */
  onClick?: () => void
  /** Destaca o item selecionado quando a faixa funciona como filtro. */
  active?: boolean
  title?: string
}

const NOTE_TONE: Record<KpiTone, string> = {
  default: 'text-foreground-2',
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  muted: 'text-muted-foreground',
}

/**
 * Faixa de KPIs do protótipo DDM: células separadas por linha de 1px
 * dentro de uma borda única (raio 10px), número de 24px. Com `loading`
 * mostra skeletons no lugar dos valores.
 */
export function KpiStrip({
  items,
  loading = false,
  minWidth = 170,
  className,
  ariaLabel,
}: {
  items: ReadonlyArray<KpiItem>
  loading?: boolean
  /** Largura mínima de cada célula antes de quebrar linha (px). */
  minWidth?: number
  className?: string
  ariaLabel?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      className={cn('grid gap-px overflow-hidden rounded-[10px] border border-border bg-border', className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))` }}
    >
      {items.map((k) => (
        <div
          key={k.label}
          title={k.title}
          className={cn(
            'relative flex flex-col gap-1.5 bg-card px-4 py-3.5 text-left',
            k.onClick && 'transition-colors hover:bg-surface-hover',
            k.active && 'bg-selected shadow-[inset_0_-2px_0_var(--primary)]',
          )}
        >
          {/* O botão cobre a célula; o "i" fica acima dele (z-index) para não aninhar botões. */}
          {k.onClick && (
            <button
              type="button"
              aria-pressed={k.active}
              aria-label={k.label}
              onClick={k.onClick}
              className="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            />
          )}
          <span className="pointer-events-none flex items-center gap-1 text-[12.5px] text-foreground-2">
            {k.label}
            {k.info != null && (
              <span className="pointer-events-auto">
                <InfoHint label={`Sobre: ${k.label}`}>{k.info}</InfoHint>
              </span>
            )}
          </span>
          <span className="pointer-events-none flex flex-wrap items-baseline gap-2">
            {loading ? (
              <Skeleton className="h-6 w-20" />
            ) : (
              <span className="text-2xl font-semibold tracking-[-0.02em] tabular-nums text-foreground">{k.value}</span>
            )}
            {!loading && k.note != null && (
              <span className={cn('text-xs font-semibold tabular-nums', NOTE_TONE[k.noteTone ?? 'muted'])}>{k.note}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
