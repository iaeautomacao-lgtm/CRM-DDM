import { BarChart3 } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared empty-state panel for charts that can't render meaningfully
 * without a minimum amount of data. Kept minimal and uniform so the
 * three empty states on the dashboard don't each feel like a
 * different widget.
 */
export function EmptyState({
  title = 'Dados insuficientes',
  hint,
  icon: Icon = BarChart3,
  className,
  children,
}: {
  title?: string
  hint?: string
  icon?: ComponentType<{ className?: string }>
  className?: string
  /** Ações da tela vazia (botões/links). */
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex h-full min-h-40 animate-ddm-fade flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border-strong bg-card/40 px-4 py-6 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary-text">
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {hint && <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>}
      {children && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  )
}
