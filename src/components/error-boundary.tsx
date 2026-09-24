"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trackError } from "@/hooks/use-telemetry";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Manual class-component boundary — additive to, not a replacement
 * for, src/app/(dashboard)/error.tsx and src/app/global-error.tsx.
 * Those already catch render errors at the route-segment level and
 * already POST to /api/telemetry via trackError with a friendly
 * fallback, but Next's `error` prop there never carries React's
 * componentStack (only a real componentDidCatch(error, errorInfo)
 * gets that) — this exists specifically to capture it for frontend
 * error investigations like React error #130/#310.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string | null }) {
    trackError(
      error.message,
      error.stack,
      typeof window !== "undefined" ? window.location.pathname : undefined,
      errorInfo.componentStack ? { component_stack: errorInfo.componentStack } : undefined,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-[#FF5706]/10">
            <AlertTriangle className="size-8 text-[#FF5706]" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">Algo deu errado</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Recarregue a página.
            </p>
          </div>
          <Button
            onClick={() => window.location.reload()}
            className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
          >
            Recarregar página
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
