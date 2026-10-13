"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/usuarios", label: "Usuários" },
  { href: "/usuarios/papeis", label: "Papéis e permissões" },
] as const;

/** Abas da área de pessoas: lista de usuários e papéis (sistema e personalizados). */
export function UsuariosTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Seções de usuários"
      className="flex max-w-full shrink-0 gap-0.5 self-start overflow-x-auto rounded-lg bg-surface-3 p-[3px] [scrollbar-width:none]"
    >
      {TABS.map(({ href, label }) => {
        const active = href === "/usuarios" ? pathname === href : pathname.startsWith(href);
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
