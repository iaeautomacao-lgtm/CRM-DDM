"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState, type ReactElement } from "react";
import {
  Headphones,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadInternalMessages } from "@/hooks/use-unread-internal-messages";
import type { AccountRole } from "@/lib/auth/roles";
import { canAccessRoute, getDefaultRoute, isRouteGated } from "@/lib/role-utils";
import {
  bottomNavItems,
  longestMatchingHref,
  matchesPrefix,
  NAV_GROUPS,
  navItems,
} from "@/lib/nav";
import { OmniDdmLogo } from "@/components/ui/omniddm-logo";
import { ChangePasswordDialog } from "@/components/layout/change-password-dialog";
import { InternalChatDialog } from "@/components/internal-chat/internal-chat-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsDesktop, useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";

function RailTooltip({
  enabled,
  label,
  children,
}: {
  enabled: boolean;
  label: string;
  children: ReactElement;
}) {
  if (!enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function navItemClass(rail: boolean, active = false) {
  return cn(
    "relative flex w-full items-center rounded-md text-[13px] font-medium transition-colors",
    rail ? "h-9 justify-center px-0" : "h-9 gap-2.5 px-2.5 text-left",
    active
      ? "bg-muted/70 text-foreground before:absolute before:left-0 before:h-4 before:w-0.5 before:rounded-full before:bg-primary"
      : "text-muted-foreground hover:bg-muted/55 hover:text-foreground",
  );
}

function RailDot() {
  return (
    <span
      aria-hidden="true"
      className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-sidebar"
    />
  );
}

function isNavItemVisible(
  href: string,
  role: AccountRole | null,
  roleLoading: boolean,
): boolean {
  const path = href.split("?")[0];
  if (!isRouteGated(path)) return true;
  if (roleLoading || !role) return false;
  return canAccessRoute(role, path);
}

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, profileLoading, accountRole } = useAuth();
  const totalUnread = useTotalUnread();
  const unreadInternalMessages = useUnreadInternalMessages(true);

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [internalChatOpen, setInternalChatOpen] = useState(false);

  const { collapsed, setCollapsed, toggle: toggleCollapsed } = useSidebarCollapsed();
  const isDesktop = useIsDesktop();
  const rail = collapsed && isDesktop;

  const visibleNavItems = navItems
    .filter((item) => isNavItemVisible(item.href, accountRole, profileLoading))
    .filter((item) => item.href !== "/settings?tab=ai" || accountRole !== "admin");

  const visibleBottomNavItems = bottomNavItems.filter((item) =>
    isNavItemVisible(item.href, accountRole, profileLoading),
  );

  const isAiTab = pathname === "/settings" && searchParams.get("tab") === "ai";
  const activeNavHref = isAiTab
    ? "/settings?tab=ai"
    : longestMatchingHref(
        pathname,
        visibleNavItems
          .map((item) => item.href)
          .filter((href) => !href.startsWith("/settings") && !href.startsWith("/relatorios")),
      );

  const homeHref = accountRole ? getDefaultRoute(accountRole) : "/dashboard";

  useEffect(() => {
    onClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const internalUnreadLabel = `${unreadInternalMessages} mensagem${unreadInternalMessages === 1 ? "" : "s"} não lida${unreadInternalMessages === 1 ? "" : "s"}`;

  const renderExtraButton = (
    key: string,
    label: string,
    Icon: typeof Headphones,
    onClick: () => void,
    unread = 0,
  ) => (
    <li key={key}>
      <RailTooltip enabled={rail} label={label}>
        <button
          type="button"
          onClick={onClick}
          aria-label={rail ? (unread > 0 ? `${label} (${internalUnreadLabel})` : label) : undefined}
          className={navItemClass(rail)}
        >
          <Icon className="h-4 w-4 shrink-0" />
          {!rail && <span className="flex-1">{label}</span>}
          {unread > 0 &&
            (rail ? (
              <RailDot />
            ) : (
              <span className="min-w-5 rounded-full bg-primary-soft px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums text-primary">
                {unread > 99 ? "99+" : unread}
              </span>
            ))}
        </button>
      </RailTooltip>
    </li>
  );

  return (
    <>
      <button
        type="button"
        aria-label="Fechar menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:z-0 lg:translate-x-0 lg:overflow-hidden lg:transition-[width]",
          rail ? "lg:w-16" : "lg:w-[232px]",
        )}
        aria-label="Navegação principal"
      >
        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-b border-sidebar-border",
            rail ? "justify-center px-2" : "justify-between gap-3 px-4",
          )}
        >
          <Link
            href={homeHref}
            aria-label="OmniDDM — página inicial"
            className="flex min-w-0 items-center"
          >
            <OmniDdmLogo symbolOnly={rail} priority />
          </Link>

          {!rail && (
            <>
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label="Recolher menu"
                title="Recolher menu (Ctrl+B)"
                className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:flex"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Fechar menu"
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
              >
                <X className="h-5 w-5" />
              </button>
            </>
          )}
        </div>

        <TooltipProvider>
          <nav className={cn("flex-1 overflow-x-hidden overflow-y-auto py-3", rail ? "px-2" : "px-2.5")}>
            {NAV_GROUPS.map((group, groupIndex) => {
              const items = visibleNavItems.filter((item) => item.group === group.id);
              if (items.length === 0) return null;

              return (
                <div
                  key={group.id}
                  className={cn(
                    groupIndex > 0 && (rail ? "mt-2 border-t border-sidebar-border pt-2" : "mt-4"),
                  )}
                >
                  {!rail && (
                    <p className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
                      {group.label}
                    </p>
                  )}

                  <ul className="flex flex-col gap-0.5">
                    {items.map((item) => {
                      const reportsActive =
                        item.href === "/relatorios/atendimentos" && pathname.startsWith("/relatorios");
                      const isActive = reportsActive || item.href === activeNavHref;
                      const showUnread = item.href === "/inbox" && totalUnread > 0 && !isActive;
                      const unreadLabel = `${totalUnread} conversa${totalUnread === 1 ? "" : "s"} não lida${totalUnread === 1 ? "" : "s"}`;

                      return (
                        <Fragment key={item.href}>
                          <li>
                            <RailTooltip enabled={rail} label={item.label}>
                              <Link
                                href={item.href}
                                aria-label={
                                  rail
                                    ? showUnread
                                      ? `${item.label} (${unreadLabel})`
                                      : item.label
                                    : undefined
                                }
                                aria-current={isActive ? "page" : undefined}
                                className={navItemClass(rail, isActive)}
                              >
                                <item.icon
                                  className={cn(
                                    "h-4 w-4 shrink-0",
                                    isActive ? "text-primary" : "text-muted-foreground",
                                  )}
                                />
                                {!rail && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                                {showUnread &&
                                  (rail ? (
                                    <RailDot />
                                  ) : (
                                    <span className="min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums text-muted-foreground">
                                      {totalUnread > 99 ? "99+" : totalUnread}
                                    </span>
                                  ))}
                              </Link>
                            </RailTooltip>
                          </li>

                          {item.href === "/inbox" && accountRole === "agent" && (
                            <>
                              {renderExtraButton(
                                "supervisor",
                                "Conversar com supervisor",
                                Headphones,
                                () => setInternalChatOpen(true),
                                unreadInternalMessages,
                              )}
                              {renderExtraButton(
                                "password-agent",
                                "Trocar senha",
                                KeyRound,
                                () => setPasswordDialogOpen(true),
                              )}
                            </>
                          )}

                          {item.href === "/inbox" &&
                            (accountRole === "admin" || accountRole === "owner") &&
                            renderExtraButton(
                              "internal",
                              "Mensagens internas",
                              Headphones,
                              () => setInternalChatOpen(true),
                              unreadInternalMessages,
                            )}

                          {item.href === "/inbox" &&
                            accountRole === "admin" &&
                            renderExtraButton(
                              "password-admin",
                              "Trocar senha",
                              KeyRound,
                              () => setPasswordDialogOpen(true),
                            )}
                        </Fragment>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </nav>

          <div className={cn("shrink-0 border-t border-sidebar-border py-2.5", rail ? "px-2" : "px-2.5")}>
            <ul className="flex flex-col gap-0.5">
              {visibleBottomNavItems.map((item) => {
                const active =
                  item.href === "/settings"
                    ? matchesPrefix(pathname, item.href) && !isAiTab
                    : matchesPrefix(pathname, item.href);
                return (
                  <li key={item.href}>
                    <RailTooltip enabled={rail} label={item.label}>
                      <Link
                        href={item.href}
                        aria-label={rail ? item.label : undefined}
                        aria-current={active ? "page" : undefined}
                        className={navItemClass(rail, active)}
                      >
                        <item.icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} />
                        {!rail && <span>{item.label}</span>}
                      </Link>
                    </RailTooltip>
                  </li>
                );
              })}

              {rail && (
                <li className="mt-1 border-t border-sidebar-border pt-2">
                  <RailTooltip enabled label="Expandir menu">
                    <button
                      type="button"
                      onClick={() => setCollapsed(false)}
                      aria-label="Expandir menu"
                      title="Expandir menu (Ctrl+B)"
                      className={navItemClass(true)}
                    >
                      <PanelLeftOpen className="h-4 w-4" />
                    </button>
                  </RailTooltip>
                </li>
              )}
            </ul>
          </div>
        </TooltipProvider>
      </aside>

      <ChangePasswordDialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} />
      <InternalChatDialog
        open={internalChatOpen}
        onOpenChange={setInternalChatOpen}
        mode={accountRole === "agent" ? "operator" : "supervisor"}
      />
    </>
  );
}
