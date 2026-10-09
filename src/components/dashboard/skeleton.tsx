import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Skeleton do dashboard — reusa o primitivo do design system
 * (components/ui/skeleton). Mantido aqui pelo SkeletonCard e para não
 * mexer nos imports dos widgets.
 */
export { Skeleton }

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-5',
        className,
      )}
    >
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-4 h-8 w-20" />
      <Skeleton className="mt-2 h-3 w-16" />
    </div>
  )
}
