"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { DDM_SESSION_STORAGE_KEY, trackError, trackPageView } from "@/hooks/use-telemetry";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { FeedbackButton } from "@/components/feedback-button";
import { RouteTransition } from "@/components/motion/route-transition";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { getDefaultRoute } from "@/lib/role-utils";
import { getPageTitle } from "@/lib/nav";
import { usePermissions } from "@/hooks/use-permission";
import { useMfaGuard } from "@/hooks/use-mfa-guard";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading, profileLoading, accountRole, authError, refreshProfile, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const permissions = usePermissions();
  // 2FA obrigatório: sessão só com senha de quem tem fator verificado vai para /login/2fa.
  useMfaGuard(!loading && !!user);

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user && !authError) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
  }, [user, loading, router, authError]);

  useEffect(() => {
    if (loading || profileLoading || permissions.loading || !user || authError) return;

    if (!accountRole) {
      if (pathname !== "/unauthorized") router.replace("/unauthorized");
      return;
    }

    // Páginas liberadas pelo servidor (GET /api/me/permissions, campo pages).
    if (!permissions.canOpen(pathname)) {
      const fallback = getDefaultRoute(accountRole);
      if (pathname !== fallback) {
        // Explica o redirecionamento — o id fixo deduplica o toast caso
        // o efeito rode de novo antes da navegação concluir. /dashboard é
        // o destino padrão pós-login de todo mundo: lá o redirecionamento
        // é só "ir para a sua tela inicial", sem aviso.
        if (pathname !== "/dashboard") {
          toast.error("Você não tem permissão para acessar esta página.", {
            id: "route-forbidden",
          });
        }
        router.replace(fallback);
      }
    }
  }, [accountRole, loading, pathname, permissions, profileLoading, router, user, authError]);

  // Título do documento por rota (WCAG 2.4.2). Fica antes do efeito de page
  // view para que a telemetria já leia o título atualizado.
  const pageTitle = pathname ? getPageTitle(pathname) : "";
  useEffect(() => {
    if (!pageTitle) return;
    document.title = `${pageTitle} - OmniDDM`;
  }, [pageTitle]);

  // Page views — dispara a cada troca de rota dentro do dashboard.
  // duration_ms enviado aqui é o tempo gasto na página ANTERIOR (por
  // isso vem do ref, calculado ANTES de trackPageView, e só depois
  // resetado pra `now`) — ver use-telemetry.ts.
  const pageEnteredAtRef = useRef<number | null>(null);
  const previousPathRef = useRef<string | null>(null);
  const isAuthenticated = !!user;
  useEffect(() => {
    if (!isAuthenticated || !pathname) return;
    // usePathname() só reflete navegações client-side de verdade —
    // nunca dispara pra prefetch (invisível nesta camada, o App Router
    // não expõe esse evento a client components) nem pra rotas de API
    // (fora da árvore que este shell envolve). Guarda defensiva mesmo
    // assim, caso isso mude.
    if (pathname.startsWith("/api")) return;

    const now = Date.now();
    const durationMs =
      pageEnteredAtRef.current != null ? now - pageEnteredAtRef.current : undefined;
    const referrer = previousPathRef.current ?? (document.referrer || undefined);
    const sessionId = window.localStorage.getItem(DDM_SESSION_STORAGE_KEY) ?? undefined;

    trackPageView(pathname, document.title, referrer, sessionId, durationMs);

    pageEnteredAtRef.current = now;
    previousPathRef.current = pathname;
  }, [pathname, isAuthenticated]);

  // Erros que escapam da árvore de render do React (error.tsx só pega
  // erros de render) — script solto, listener de evento, promise sem
  // catch. Um listener global por montagem do shell, nunca em loop.
  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      trackError(event.message, event.error?.stack, window.location.pathname);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      trackError(message, stack, window.location.pathname);
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  if (authError) return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6" role="alert">
      <p>{authError}</p>
      <button onClick={() => user ? void refreshProfile() : window.location.reload()} className="rounded border px-4 py-2">Tentar novamente</button>
      <button onClick={() => void signOut()} className="rounded border px-4 py-2">Sair da conta</button>
    </div>
  );
  if (loading || (user && profileLoading)) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground" role="status">Carregando...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-overlay focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Pular para o conteúdo
      </a>
      {/* Anuncia a nova página a leitores de tela sem mover o foco de quem está digitando. */}
      <div role="status" aria-live="polite" className="sr-only">
        {pageTitle}
      </div>
      <FeedbackButton />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main id="conteudo" tabIndex={-1} className="flex-1 overflow-y-auto p-4 outline-none sm:p-6">
          <RouteTransition className="h-full">{children}</RouteTransition>
        </main>
        <CommandPalette />
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
