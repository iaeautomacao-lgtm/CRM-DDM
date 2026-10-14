import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

/** Nome do copiloto interno do CRM. Os Agentes de IA (que falam com o cliente) NÃO usam este nome. */
export const ACORDITO = "Acordito";

const SIZES = { sm: "size-5 [&>svg]:size-3", md: "size-7 [&>svg]:size-4", lg: "size-10 [&>svg]:size-5" } as const;

/** Marca do Acordito: ícone sobre o token primary (sem arte externa por enquanto). */
export function AcorditoAvatar({ size = "md", className }: { size?: keyof typeof SIZES; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-primary-solid text-primary-foreground",
        SIZES[size],
        className,
      )}
    >
      <Sparkles />
    </span>
  );
}

/** Avatar + nome (ou outro texto), para títulos de painéis do Acordito. */
export function AcorditoMark({ children = ACORDITO, size = "sm", className }: { children?: ReactNode; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-semibold text-foreground", className)}>
      <AcorditoAvatar size={size} />
      {children}
    </span>
  );
}
