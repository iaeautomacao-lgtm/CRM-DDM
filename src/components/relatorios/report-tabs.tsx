"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePermissions } from "@/hooks/use-permission";
import { reportNavItems } from "@/lib/nav";
import { cn } from "@/lib/utils";

export function ReportTabs() {
  const pathname = usePathname();
  const { canOpen } = usePermissions();

  // Abas que o servidor libera (GET /api/me/permissions, campo pages).
  const visible = reportNavItems.filter((item) => canOpen(item.href));

  if (visible.length === 0) return null;

  return (
    <nav
      aria-label="Seções de relatórios"
      className="flex h-11 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-background px-3 lg:px-6"
    >
      {visible.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center border-b-2 px-3 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
