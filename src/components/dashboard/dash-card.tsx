import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Painel do Dashboard (Design System DDM): cartão com canto de 20px e
 * sombra sm, título em Poppins 16px e subtítulo opcional. `action` fica à direita do título.
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
        'flex min-w-0 flex-col gap-4 rounded-card bg-card p-5 shadow-sm dark:border dark:border-border',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="m-0 font-heading text-base font-semibold text-foreground">{title}</h3>
          {subtitle ? <p className="m-0 text-[12.5px] text-muted-foreground">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

// Seletor segmentado: movido para o design system (components/ddm).
export { Segmented } from '@/components/ddm/segmented'

/** Quadradinho de legenda. */
export function Swatch({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-[2px]', className)} />
}
