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

// Seletor segmentado: movido para o design system (components/ddm).
export { Segmented } from '@/components/ddm/segmented'

/** Quadradinho de legenda. */
export function Swatch({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-[2px]', className)} />
}
