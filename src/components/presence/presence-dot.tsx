import { cn } from "@/lib/utils";
import type { PresenceStatus } from "@/lib/presence";

// Fonte única das cores de presença: preenchimentos semânticos do Design System
// DDM (bg-success-fill / bg-warning-fill). No claro eles ficam abaixo de 3:1 no
// branco, então o ponto isolado leva um anel fino e o significado sempre vem
// junto de um rótulo (label/tooltip), nunca só pela cor.
export const PRESENCE_DOT_CLASS: Record<PresenceStatus, string> = {
  online: "bg-success-fill",
  away: "bg-warning-fill",
  offline: "bg-muted-foreground/50",
};

/**
 * A small presence dot. Used inline (e.g. the inbox Assign dropdown)
 * and, with `asAvatarBadge`-style positioning supplied via className,
 * layered onto an avatar. `label` powers the native title/aria for
 * the lightweight inline case; the roster wraps it in a real Tooltip.
 */
export function PresenceDot({
  status,
  label,
  className,
}: {
  status: PresenceStatus;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full ring-1 ring-foreground/15",
        PRESENCE_DOT_CLASS[status],
        className,
      )}
    />
  );
}
