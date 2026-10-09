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
      className="flex max-w-full shrink-0 gap-0.5 self-start overflow-x-auto rounded-lg bg-surface-3 p-[3px] [scrollbar-width:none]"
    >
      {visible.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-[6px] px-3 text-[12.5px] font-semibold transition-colors",
              active
                ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.12),0_0_0_1px_var(--border)]"
                : "text-foreground-2 hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
