import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Cabeçalho de página do design system DDM: descrição (um estilo só) e ações à direita.
 * O TÍTULO da tela fica só no h1 do cabeçalho do layout (header.tsx): aqui não se repete.
 * `heading` é só para telas de detalhe cujo nome é dinâmico (ex.: nome da equipe, da automação),
 * e nunca para repetir o rótulo do menu. Sem descrição, ações nem título, não renderiza nada.
 */
export function PageHeader({
  children,
  actions,
  badge,
  heading,
  className,
}: {
  /** Descrição curta da tela (uma ou duas frases). */
  children?: ReactNode
  /** Botões/estado à direita (botão primário por último). */
  actions?: ReactNode
  /** Selo ao lado da descrição (ex.: "Beta"). */
  badge?: ReactNode
  /** Nome do item em telas de detalhe. */
  heading?: ReactNode
  className?: string
}) {
  if (!children && !actions && !badge && !heading) return null
  return (
    <div className={cn('flex animate-ddm-up flex-wrap items-start justify-between gap-3 pt-1', className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {heading && <h2 className="font-heading text-xl font-semibold leading-tight tracking-[-0.02em] text-foreground">{heading}</h2>}
        {(children || badge) && (
          <div className="flex flex-wrap items-center gap-2">
            {children && <p className="m-0 max-w-[620px] text-sm leading-relaxed text-muted-foreground">{children}</p>}
            {badge}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
