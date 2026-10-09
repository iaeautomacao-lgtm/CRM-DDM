"use client"

import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * Ícone "i" com a explicação de um número ou campo. É um botão que abre um
 * popover: funciona com mouse, teclado (Enter/Espaço, Esc fecha) e toque no
 * celular, ao contrário de `title` ou tooltip de hover.
 */
export function InfoHint({
  children,
  label = 'O que é isto?',
  className,
}: {
  /** Texto da explicação. */
  children: ReactNode
  /** Nome acessível do botão (ex.: "Sobre: Taxa de conversão"). */
  label?: string
  className?: string
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          'relative z-[1] inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
          className,
        )}
      >
        <Info className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64 text-xs leading-relaxed text-foreground-2">
        {children}
      </PopoverContent>
    </Popover>
  )
}
