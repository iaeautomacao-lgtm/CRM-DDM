import { cn } from "@/lib/utils"

/**
 * Bloco de carregamento do design system DDM: superfície neutra com o
 * pulso do protótipo (animate-pulse = ddm-pulse, 1.3s). `aria-hidden`
 * porque o estado de carregamento é anunciado pelo contêiner
 * (role="status" / aria-busy), não por cada bloco.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-surface-3", className)}
      {...props}
    />
  )
}

export { Skeleton }
