'use client'

import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Estado de erro compartilhado (Dashboard, Relatórios, Monitoramento):
 * mesmo visual do EmptyState, com ícone de alerta e botão "Tentar
 * novamente" — evita que uma falha de carregamento deixe skeletons
 * eternos ou uma tela vazia sem explicação.
 */
export function ErrorState({
  title = 'Não foi possível carregar os dados',
  hint = 'Verifique sua conexão e tente novamente.',
  onRetry,
  className,
}: {
  title?: string
  hint?: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-destructive/40 bg-card/40 px-4 py-6 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>}
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-1" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Tentar novamente
        </Button>
      )}
    </div>
  )
}
