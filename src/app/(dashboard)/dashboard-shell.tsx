"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { DDM_SESSION_STORAGE_KEY, trackError, trackPageView } from "@/hooks/use-telemetry";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { canAccessRoute, getDefaultRoute, isRouteGated } from "@/lib/role-utils";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading, profileLoading, accountRole } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (loading || profileLoading || !user) return;

    if (!accountRole) {
      if (pathname !== "/unauthorized") router.replace("/unauthorized");
      return;
    }

    if (isRouteGated(pathname) && !canAccessRoute(accountRole, pathname)) {
      const fallback = getDefaultRoute(accountRole);
      if (pathname !== fallback) router.replace(fallback);
    }
  }, [accountRole, loading, pathname, profileLoading, router, user]);

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

  if (loading || (user && profileLoading)) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
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
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
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
