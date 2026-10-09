"use client"

import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string | number> {
  value: T
  label: string
  /** Contagem opcional ao lado do rótulo (ex.: "Ativas 3"). Só valor real. */
  count?: number | string
}

/**
 * Seletor segmentado do design system DDM (período, filtros de lista):
 * trilho em surface-3, opção ativa em card com sombra fina, `aria-pressed`
 * em cada opção. Rola na horizontal quando não cabe (celular).
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (v: T) => void
  ariaLabel: string
  /** sm = 24px, md = 26px, lg = 28px (filtro principal de lista). */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('flex max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-lg bg-surface-3 p-[3px] [scrollbar-width:none]', className)}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-[6px] font-semibold transition-colors',
              size === 'sm' && 'h-6 px-[9px] text-xs',
              size === 'md' && 'h-[26px] px-2.5 text-xs',
              size === 'lg' && 'h-7 px-2.5 text-[12.5px]',
              on
                ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.12),0_0_0_1px_var(--border)]'
                : 'text-foreground-2 hover:text-foreground',
            )}
          >
            {o.label}
            {o.count != null && (
              <span className="ml-1 font-medium tabular-nums text-muted-foreground">
                {typeof o.count === 'number' ? o.count.toLocaleString('pt-BR') : o.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
