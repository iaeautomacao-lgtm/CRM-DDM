"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useRef, useState, type ReactElement } from "react";
import {
  ChevronDown,
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
import { getDefaultRoute } from "@/lib/role-utils";
import { usePermissions } from "@/hooks/use-permission";
import {
  bottomNavItems,
  longestMatchingHref,
  matchesPrefix,
  NAV_GROUPS,
  navItems,
  type NavGroup,
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
    "relative flex w-full items-center rounded-field text-sm transition-colors duration-150 ease-out",
    rail ? "h-10 justify-center px-0" : "h-10 gap-3 px-3.5 text-left",
    active
      ? "bg-primary-solid font-semibold text-white shadow-sm"
      : "font-medium text-foreground-2 hover:bg-surface-hover hover:text-foreground",
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

// Grupos que o usuário recolheu, guardados no navegador (preferência por pessoa).
const CLOSED_GROUPS_KEY = "wacrm.sidebar.closedGroups";

function readClosedGroups(): NavGroup[] {
  try {
    const raw = window.localStorage.getItem(CLOSED_GROUPS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((g): g is NavGroup => typeof g === "string") : [];
  } catch {
    return [];
  }
}

function writeClosedGroups(groups: NavGroup[]) {
  try {
    window.localStorage.setItem(CLOSED_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    // sem localStorage (aba anônima, bloqueio): só não lembra a escolha
  }
}

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { accountRole } = useAuth();
  const totalUnread = useTotalUnread();
  const unreadInternalMessages = useUnreadInternalMessages(true);

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [internalChatOpen, setInternalChatOpen] = useState(false);

  const { collapsed, setCollapsed, toggle: toggleCollapsed } = useSidebarCollapsed();
  const isDesktop = useIsDesktop();
  const rail = collapsed && isDesktop;

  // Itens que o servidor libera (GET /api/me/permissions, campo pages).
  const { canOpen, can } = usePermissions();
  const visibleNavItems = navItems
    .filter((item) => canOpen(item.href.split("?")[0]))
    // Agentes de IA: quem não vê agentes não vê o item (a aba de Configurações exige ai.agents.view).
    .filter((item) => item.href !== "/settings?tab=agents" || can("ai.agents.view"))
    .filter((item) => !item.permission || can(item.permission));

  const visibleBottomNavItems = bottomNavItems.filter((item) => canOpen(item.href.split("?")[0]));

  const isAgentsTab = pathname === "/settings" && searchParams.get("tab") === "agents";
  const activeNavHref = isAgentsTab
    ? "/settings?tab=agents"
    : longestMatchingHref(
        pathname,
        visibleNavItems
          .map((item) => item.href)
          .filter((href) => !href.startsWith("/settings") && !href.startsWith("/relatorios")),
      );

  // Grupos recolhidos. O grupo da tela atual abre sozinho ao navegar.
  const [closedGroups, setClosedGroups] = useState<NavGroup[]>([]);
  useEffect(() => {
    setClosedGroups(readClosedGroups());
  }, []);
  const activeGroup = visibleNavItems.find(
    (item) => item.href === activeNavHref || (item.href === "/relatorios/atendimentos" && pathname.startsWith("/relatorios")),
  )?.group;
  useEffect(() => {
    if (!activeGroup) return;
    setClosedGroups((prev) => {
      if (!prev.includes(activeGroup)) return prev;
      const next = prev.filter((g) => g !== activeGroup);
      writeClosedGroups(next);
      return next;
    });
  }, [activeGroup]);
  const toggleGroup = (id: NavGroup) => {
    setClosedGroups((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      writeClosedGroups(next);
      return next;
    });
  };

  const homeHref = accountRole ? getDefaultRoute(accountRole) : "/dashboard";

  useEffect(() => {
    onClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Gaveta fechada no celular: fora da ordem de foco e da árvore de acessibilidade.
  const drawerHidden = !open && !isDesktop;

  // Foco: ao abrir vai para o botão "Fechar menu" da gaveta; ao fechar volta
  // para o botão que abriu.
  const openerRef = useRef<HTMLElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || isDesktop) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    drawerCloseRef.current?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, isDesktop]);

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
          <Icon className="size-[18px] shrink-0" />
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
        aria-hidden="true"
        tabIndex={-1}
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
        inert={drawerHidden}
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
                ref={drawerCloseRef}
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
          <nav
            className={cn(
              // rola com roda/toque, sem mostrar a barra
              "flex-1 overflow-x-hidden overflow-y-auto py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              rail ? "px-2" : "px-2.5",
            )}
          >
            {NAV_GROUPS.map((group, groupIndex) => {
              const items = visibleNavItems.filter((item) => item.group === group.id);
              if (items.length === 0) return null;
              // No modo só ícones todos os grupos ficam abertos.
              const groupOpen = rail || !closedGroups.includes(group.id);
              const listId = `nav-group-${group.id}`;

              return (
                <div
                  key={group.id}
                  className={cn(
                    groupIndex > 0 && (rail ? "mt-2 border-t border-sidebar-border pt-2" : "mt-4"),
                  )}
                >
                  {!rail && (
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      aria-expanded={groupOpen}
                      aria-controls={listId}
                      className="mb-1.5 flex w-full items-center justify-between rounded-md px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70 transition-colors hover:text-foreground"
                    >
                      <span>{group.label}</span>
                      <ChevronDown
                        aria-hidden="true"
                        className={cn("size-3.5 transition-transform duration-150", !groupOpen && "-rotate-90")}
                      />
                    </button>
                  )}

                  <ul id={listId} className={cn("flex-col gap-0.5", groupOpen ? "flex" : "hidden")}>
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
                                    "size-[18px] shrink-0",
                                    isActive ? "text-white" : "text-muted-foreground",
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
                                "Mensagens internas",
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
                            (accountRole === "admin" || accountRole === "owner" || accountRole === "supervisor") &&
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
                    ? matchesPrefix(pathname, item.href) && !isAgentsTab
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
