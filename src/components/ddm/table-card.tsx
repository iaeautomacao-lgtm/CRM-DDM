import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Cartão de tabela do protótipo DDM: cabeçalho com título, dica e ação à
 * direita; corpo rola na horizontal quando a tabela não cabe. Use com
 * DenseTable/Th/Td abaixo (ou qualquer conteúdo).
 */
export function TableCard({
  title,
  hint,
  action,
  children,
  className,
  label,
}: {
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  /** aria-label da seção (padrão: título quando for texto). */
  label?: string
}) {
  return (
    <section
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      className={cn('overflow-hidden rounded-[10px] border border-border bg-card', className)}
    >
      {(title || action) && (
        <div className="flex flex-wrap items-center gap-2.5 px-[18px] py-3.5">
          <div className="min-w-[200px] flex-1">
            {title && <h3 className="m-0 font-sans text-sm font-semibold text-foreground">{title}</h3>}
            {hint && <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">{hint}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="overflow-x-auto overflow-y-hidden">{children}</div>
    </section>
  )
}

/** Tabela densa (13px). `minWidth` evita espremer colunas no celular. */
export function DenseTable({ className, minWidth, style, ...props }: ComponentProps<'table'> & { minWidth?: number }) {
  return (
    <table
      className={cn('w-full border-collapse text-[13px]', className)}
      style={{ minWidth, ...style }}
      {...props}
    />
  )
}

/** Cabeçalho de coluna (fundo surface-3, 12px). */
export function Th({ className, align = 'left', ...props }: ComponentProps<'th'> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap border-y border-border bg-surface-3 px-[18px] py-2.5 text-xs font-semibold text-foreground-2',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
      {...props}
    />
  )
}

/** Linha com realce do protótipo (fundo + barra laranja à esquerda no hover). */
export function Tr({ className, interactive = true, onKeyDown, onClick, tabIndex, ...props }: ComponentProps<'tr'> & { interactive?: boolean }) {
  // Linha clicável vira operável por teclado (Enter/Espaço); props do chamador prevalecem.
  const keyboardRow = interactive && typeof onClick === 'function'
  return (
    <tr
      className={cn(
        interactive &&
          'transition-[background-color,box-shadow] duration-150 hover:bg-surface-hover hover:shadow-[inset_2px_0_0_var(--primary)]',
        keyboardRow && 'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        className,
      )}
      onClick={onClick}
      tabIndex={tabIndex ?? (keyboardRow ? 0 : undefined)}
      onKeyDown={
        onKeyDown ??
        (keyboardRow
          ? (e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.currentTarget.click()
              }
            }
          : undefined)
      }
      {...props}
    />
  )
}

export function Td({ className, align = 'left', ...props }: ComponentProps<'td'> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <td
      className={cn(
        'border-b border-border px-[18px] py-[11px] align-middle',
        align === 'right' ? 'text-right tabular-nums' : align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
      {...props}
    />
  )
}

/** Célula principal: texto forte + linha secundária opcional. */
export function CellMain({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-semibold text-foreground">{title}</span>
      {sub != null && sub !== '' && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
    </span>
  )
}

/** Barra de proporção dentro da célula (ex.: taxa de leitura). */
export function CellBar({ pct, label, className }: { pct: number; label: ReactNode; className?: string }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <span className="flex min-w-[140px] items-center gap-2.5">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <span className={cn('block h-full origin-left animate-ddm-bar rounded-full bg-primary', className)} style={{ width: `${w}%` }} />
      </span>
      <span className="w-[46px] text-right text-xs tabular-nums text-foreground-2">{label}</span>
    </span>
  )
}
