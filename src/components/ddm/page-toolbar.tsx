import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Linha de ferramentas da lista (protótipo DDM): filtros/busca à esquerda,
 * ações à direita (botão primário por último). Quebra linha no celular.
 */
export function PageToolbar({
  children,
  actions,
  className,
}: {
  /** Filtros, busca, segmentado. */
  children?: ReactNode
  /** Botões à direita. */
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {children}
      <span className="flex-1" />
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Contêiner de página do redesenho: largura máxima 1320px e espaçamento padrão. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto flex w-full max-w-[1320px] flex-col gap-3.5 px-4 pb-10 pt-4 md:px-7 md:pb-12 md:pt-6', className)}>
      {children}
    </div>
  )
}
