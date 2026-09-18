"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trackError } from "@/hooks/use-telemetry";

// Error boundary do App Router para o grupo (dashboard) — pega erros de
// render lançados por qualquer página dentro do shell autenticado.
// Não cobre erros fora dele (login, join, etc.) nem um erro no próprio
// root layout — ver src/app/global-error.tsx para esses dois casos.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    trackError(
      error.message,
      error.stack,
      typeof window !== "undefined" ? window.location.pathname : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-[#FF5706]/10">
        <AlertTriangle className="size-8 text-[#FF5706]" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">Algo deu errado</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Ocorreu um erro inesperado nesta página. Você pode tentar de novo ou
          recarregar a página.
        </p>
      </div>
      <Button
        onClick={() => reset()}
        className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
      >
        Tentar novamente
      </Button>
    </div>
  );
}
