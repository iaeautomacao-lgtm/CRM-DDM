import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type StatusTone = 'ok' | 'warn' | 'bad' | 'mute' | 'info' | 'brand'

const TONE: Record<StatusTone, string> = {
  // No claro, o verde/azul dos tokens fica abaixo de 4,5:1 sobre o fundo suave do chip (11,5px): texto mais escuro.
  ok: 'bg-success-soft text-success [html[data-mode=light]_&]:text-[#147443]',
  warn: 'bg-warning-soft text-warning',
  bad: 'bg-danger-soft text-danger',
  mute: 'bg-surface-3 text-foreground-2',
  info: 'bg-[rgba(91,141,239,.14)] text-[#5B8DEF] [html[data-mode=light]_&]:bg-[#EAF0FC] [html[data-mode=light]_&]:text-[#2d5cc0]',
  brand: 'bg-primary-soft text-primary-text',
}

/**
 * Chip de status do protótipo DDM: pílula de 22px com ponto na cor do tom.
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
        'inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11.5px] font-semibold',
        TONE[tone],
        className,
      )}
    >
      {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}
