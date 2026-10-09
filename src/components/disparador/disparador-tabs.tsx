"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, AlertTriangle, Gauge, Megaphone, Phone, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

// Abas fixas do Disparador (todas as telas de /disparador/*). Altura fixa (2,75 rem): as telas que usam
// h-[calc(100vh-4rem)] descontam esta altura (h-[calc(100vh-4rem-2.75rem)]). O acesso a /disparador/* (e às
// APIs) já é só de owner/admin.
export const DISPARADOR_TABS = [
  { href: "/disparador/campanhas", label: "Campanhas", icon: Megaphone },
  { href: "/disparador/monitor", label: "Monitor", icon: Activity },
  { href: "/disparador/numeros", label: "Números", icon: Phone },
  { href: "/disparador/controles", label: "Controles", icon: SlidersHorizontal },
  { href: "/disparador/desempenho", label: "Desempenho", icon: Gauge },
  { href: "/disparador/erros", label: "Erros", icon: AlertTriangle },
  { href: "/disparador/blacklist", label: "Blacklist", icon: ShieldAlert },
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
      // Faixa de largura total colada no topo (protótipo DDM): anula o
      // padding do <main> do shell e fica fixa ao rolar.
      className="sticky -top-4 z-20 -mx-4 -mt-4 mb-4 flex h-11 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-card px-4 [scrollbar-width:none] sm:-top-6 sm:-mx-6 sm:-mt-6 sm:mb-6"
    >
      {DISPARADOR_TABS.map(({ href, label, icon: Icon }) => {
        const active = isTabActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[13px] transition-colors",
              active
                ? "border-primary font-semibold text-foreground"
                : "border-transparent font-medium text-foreground-2 hover:text-foreground",
            )}
          >
            <Icon className={cn("size-3.5", active ? "text-primary-text" : "text-muted-foreground")} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
