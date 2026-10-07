"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, AlertTriangle, Gauge, Megaphone } from "lucide-react";
import { cn } from "@/lib/utils";

// Abas fixas do Disparador (todas as telas de /disparador/*). Altura fixa (2,75 rem): as telas que usam
// h-[calc(100vh-4rem)] descontam esta altura (h-[calc(100vh-4rem-2.75rem)]). Números e Controles entram
// aqui quando existirem (P1-5/P1-6).
export const DISPARADOR_TABS = [
  { href: "/disparador/campanhas", label: "Campanhas", icon: Megaphone },
  { href: "/disparador/monitor", label: "Monitor", icon: Activity },
  { href: "/disparador/desempenho", label: "Desempenho", icon: Gauge },
  { href: "/disparador/erros", label: "Erros", icon: AlertTriangle },
] as const;

export function isTabActive(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DisparadorTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Seções do Disparador"
      className="flex h-11 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-background px-3 lg:px-6"
    >
      {DISPARADOR_TABS.map(({ href, label, icon: Icon }) => {
        const active = isTabActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
