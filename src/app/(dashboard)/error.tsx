"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { ErrorScreen } from "@/components/errors/error-screen";
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
    <ErrorScreen
      tone="danger"
      icon={AlertTriangle}
      title="Algo deu errado"
      description="Ocorreu um erro inesperado nesta página. Você pode tentar novamente ou voltar ao início do CRM."
      reference={error?.digest}
      actions={
        <>
          <Button onClick={() => reset()}>Tentar novamente</Button>
          <Button variant="outline" onClick={() => window.location.assign("/")}>
            Voltar ao início
          </Button>
        </>
      }
    />
  );
}
