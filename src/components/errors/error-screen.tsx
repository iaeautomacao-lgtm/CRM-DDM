import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ErrorTone = "neutral" | "danger" | "warning";

const TONE: Record<ErrorTone, { badge: string; chip: string }> = {
  neutral: { badge: "bg-surface-3 text-foreground-2", chip: "bg-surface-3 text-foreground-2" },
  danger: { badge: "bg-danger-soft text-danger", chip: "bg-danger-soft text-danger" },
  warning: { badge: "bg-warning-soft text-warning", chip: "bg-warning-soft text-warning" },
};

/**
 * Tela de erro do redesenho DDM (protótipo "Erros"): selo com ícone, código curto,
 * título, explicação e ações. Nunca recebe mensagem técnica nem stack — só texto
 * já pensado para o usuário e, opcionalmente, o código de referência (digest).
 */
export function ErrorScreen({
  code,
  title,
  description,
  icon: Icon,
  tone = "neutral",
  actions,
  reference,
  fullScreen = false,
  className,
}: {
  code?: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  tone?: ErrorTone;
  actions?: ReactNode;
  /** Código de referência para o suporte (digest do Next). Não é detalhe técnico. */
  reference?: string | null;
  fullScreen?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center px-4",
        fullScreen ? "min-h-screen bg-background" : "min-h-[60vh]",
        className,
      )}
    >
      <div className="flex w-full max-w-md animate-ddm-up flex-col items-center gap-4 rounded-[14px] border border-border bg-card p-8 text-center shadow-sm">
        <div className={cn("flex size-14 items-center justify-center rounded-full", TONE[tone].badge)}>
          <Icon className="size-7" />
        </div>
        {code && (
          <span className={cn("inline-flex h-[22px] items-center rounded-full px-2.5 text-[11.5px] font-semibold tracking-wide", TONE[tone].chip)}>
            {code}
          </span>
        )}
        <div className="space-y-2">
          <h1 className="font-heading text-2xl font-semibold tracking-[-0.02em] text-foreground">{title}</h1>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {actions && <div className="mt-1 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">{actions}</div>}
        {reference ? (
          <p className="text-xs text-muted-foreground">
            Código do erro: <span className="font-mono text-foreground-2">{reference}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
