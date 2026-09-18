"use client";

import { useEffect } from "react";
import { trackError } from "@/hooks/use-telemetry";

// Fallback de último nível — só dispara quando o PRÓPRIO root layout
// (src/app/layout.tsx) lança durante o render, então precisa renderizar
// <html>/<body> por conta própria (substitui o layout inteiro, não só
// o children). Estilo inline de propósito: não é seguro assumir que
// globals.css/Tailwind estão disponíveis quando é justamente o layout
// raiz que falhou — é a recomendação oficial do Next.js para este
// arquivo específico.
export default function GlobalError({
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
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          textAlign: "center",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          backgroundColor: "#0a0a0a",
          color: "#f5f5f5",
        }}
      >
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
            Algo deu errado
          </h2>
          <p
            style={{
              fontSize: 14,
              color: "#a1a1aa",
              maxWidth: 360,
              marginTop: 8,
            }}
          >
            Ocorreu um erro inesperado. Tente recarregar a página.
          </p>
        </div>
        <button
          onClick={() => reset()}
          style={{
            backgroundColor: "#FF5706",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "8px 20px",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Tentar novamente
        </button>
      </body>
    </html>
  );
}
