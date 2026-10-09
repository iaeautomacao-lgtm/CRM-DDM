"use client";

import { AlertTriangle } from "lucide-react";

import { ErrorScreen } from "@/components/errors/error-screen";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorScreen
      fullScreen
      tone="danger"
      icon={AlertTriangle}
      title="Algo deu errado"
      description="Ocorreu um erro inesperado. Você pode tentar novamente ou voltar ao início."
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
