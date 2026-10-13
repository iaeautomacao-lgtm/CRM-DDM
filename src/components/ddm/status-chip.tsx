import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type StatusTone = 'ok' | 'warn' | 'bad' | 'mute' | 'info' | 'brand'

const TONE: Record<StatusTone, string> = {
  // Fundos suaves do DS; o texto usa os tokens semânticos, que passam AA sobre eles (claro e escuro).
  ok: 'bg-success-soft text-success',
  warn: 'bg-warning-soft text-warning',
  bad: 'bg-danger-soft text-danger',
  mute: 'bg-surface-3 text-foreground-2',
  info: 'bg-info-soft text-info',
  brand: 'bg-primary-soft text-primary-text',
}

/**
 * Chip de status do protótipo DDM: pílula de 24px com ponto na cor do tom.
 * O texto sempre acompanha a cor (nunca só cor). `dot={false}` tira o ponto.
 */
export function StatusChip({
  tone,
  children,
  dot = true,
  className,
  title,
}: {
  tone: StatusTone
  children: ReactNode
  dot?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold',
        TONE[tone],
        className,
      )}
    >
      {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}
