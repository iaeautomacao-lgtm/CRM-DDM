"use client";

import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-[#FF5706]/10">
          <AlertTriangle className="h-8 w-8 text-[#FF5706]" />
        </div>

        <h2 className="text-2xl font-semibold text-foreground">Algo deu errado</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Ocorreu um erro inesperado. Você pode tentar novamente ou voltar ao início.
        </p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button
            onClick={() => reset()}
            className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
          >
            Tentar novamente
          </Button>
          <Button
            variant="outline"
            onClick={() => window.location.assign("/")}
            className="border-border text-foreground hover:bg-muted"
          >
            Voltar ao início
          </Button>
        </div>

        {error?.digest ? (
          <p className="mt-4 text-xs text-muted-foreground">Erro: {error.digest}</p>
        ) : null}
      </div>
    </div>
  );
}
