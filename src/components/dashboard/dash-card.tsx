import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Painel do Dashboard (protótipo DDM): superfície com borda de 1px, raio
 * 10px, título 14px e subtítulo opcional. `action` fica à direita do título.
 */
export function DashCard({
  title,
  subtitle,
  action,
  label,
  className,
  children,
}: {
  title: string
  subtitle?: ReactNode
  action?: ReactNode
  /** aria-label da seção (padrão: o título). */
  label?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={label ?? title}
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-[10px] border border-border bg-card px-5 py-[18px]',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="m-0 font-sans text-sm font-semibold text-foreground">{title}</h3>
          {subtitle ? <p className="m-0 text-[12.5px] text-muted-foreground">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * Seletor segmentado (7/30/90 dias, Valor/Acordos): trilho em surface-3,
 * opção ativa em card com sombra fina.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel: string
  size?: 'sm' | 'md'
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex shrink-0 gap-0.5 rounded-lg bg-surface-3 p-[3px]">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'whitespace-nowrap rounded-[6px] font-semibold transition-colors',
              size === 'sm' ? 'h-6 px-[9px] text-xs' : 'h-[26px] px-2.5 text-xs',
              on
                ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.12),0_0_0_1px_var(--border)]'
                : 'text-foreground-2 hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Quadradinho de legenda. */
export function Swatch({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-[2px]', className)} />
}
