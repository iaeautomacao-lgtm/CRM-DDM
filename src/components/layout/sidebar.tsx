"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import {
  BarChart2,
  ChevronDown,
  ChevronUp,
  Headphones,
  KeyRound,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  User,
  UsersRound,
  X,
} from "lucide-react";
import type { AccountRole } from "@/lib/auth/roles";
import { canAccessRoute, getDefaultRoute, isRouteGated } from "@/lib/role-utils";
import {
  bottomNavItems,
  longestMatchingHref,
  matchesPrefix,
  navItems,
  reportNavItems,
} from "@/lib/nav";
import { ROLE_META } from "@/components/settings/role-meta";
import { DdmLogo } from "@/components/ui/ddm-logo";
import { ChangePasswordDialog } from "@/components/layout/change-password-dialog";
import { InternalChatDialog } from "@/components/internal-chat/internal-chat-dialog";
import { useUnreadInternalMessages } from "@/hooks/use-unread-internal-messages";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsDesktop, useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";

// No modo "rail" (desktop recolhido) o rótulo some, então cada item ganha
// um tooltip à direita. Fora do rail devolve o elemento intacto. O
// tooltip é complementar — os itens continuam com aria-label próprio.
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

// Classes-base de um item da navegação nos dois modos (rail = só ícone).
// Expandido: mais alto no mobile para o dedo acertar a linha (≥44px).
function navItemClass(rail: boolean, ...extra: Array<string | false | undefined>) {
  return cn(
    "flex w-full items-center rounded-lg text-sm font-medium transition-colors",
    rail ? "relative h-9 justify-center px-0" : "gap-3 px-3 py-2.5 text-left lg:py-2",
    ...extra,
  );
}

const INACTIVE_ITEM = "text-muted-foreground hover:bg-muted hover:text-foreground";
const ACTIVE_ITEM = "bg-primary/10 text-primary";

// Bolinha de não-lidas sobre o ícone no rail.
function RailDot() {
  return (
    <span
      aria-hidden="true"
      className="absolute top-1.5 right-3 h-2 w-2 rounded-full bg-primary ring-2 ring-card"
    />
  );
}

// RBAC visibility for a single nav item's href (which may carry a
// query string, e.g. "/settings?tab=ai"). Items whose path isn't in
// ROUTE_ALLOWLIST are always shown — this only hides the handful of
// routes that table actually restricts. While the role hasn't
// resolved yet, gated items are hidden (fail-closed) rather than
// flashing in and then disappearing.
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
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, profile, profileLoading, account, accountRole, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  const isReportsActive = pathname.startsWith("/relatorios");
  // Auto-expanded when already on a Relatórios page; otherwise the
  // user opens it manually, same as MonitorFiltersPanel's toggle.
  const [reportsOpen, setReportsOpen] = useState(isReportsActive);
  // Operators (role='agent') have no /perfil or /settings access —
  // "Trocar senha" opens this inline instead of routing anywhere.
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [internalChatOpen, setInternalChatOpen] = useState(false);
  const unreadInternalMessages = useUnreadInternalMessages(true);
  // Desktop: expandido (w-60) ou "rail" só com ícones (w-16). No mobile
  // a sidebar é sempre o drawer expandido — `rail` nunca vale lá.
  const { collapsed, setCollapsed, toggle: toggleCollapsed } = useSidebarCollapsed();
  const isDesktop = useIsDesktop();
  const rail = collapsed && isDesktop;
  const internalUnreadLabel = `${unreadInternalMessages} mensagem${unreadInternalMessages === 1 ? "" : "s"} não lida${unreadInternalMessages === 1 ? "" : "s"}`;

  // Team name(s) shown under the agent's name in the footer — direct
  // team_members -> teams lookup (no embedded join: team_members.user_id
  // has no FK to profiles, and the same dead-end shape applies to teams,
  // so this is two plain queries same as InternalChatDialog's contact
  // lookups). Owner/admin/viewer don't have a "my team" concept, so this
  // stays empty (and unrendered) for them.
  const [teamNames, setTeamNames] = useState<string[]>([]);
  useEffect(() => {
    if (accountRole !== "agent" || !user?.id) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const { data: memberships } = await supabase
        .from("team_members")
        .select("team_id")
        .eq("user_id", user.id);
      const teamIds = (memberships ?? []).map((m) => m.team_id as string);
      if (teamIds.length === 0) {
        if (!cancelled) setTeamNames([]);
        return;
      }
      const { data: teamRows } = await supabase
        .from("teams")
        .select("name")
        .in("id", teamIds);
      if (!cancelled) setTeamNames((teamRows ?? []).map((t) => t.name as string));
    })();
    return () => {
      cancelled = true;
    };
  }, [accountRole, user?.id]);
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name;

  // RBAC: hide the handful of routes ROUTE_ALLOWLIST restricts for the
  // current role. Everything else passes through unfiltered.
  //
  // "Agente de IA" needs a second, more specific filter on top:
  // ROUTE_ALLOWLIST gates /settings as a whole (owner+admin), but this
  // one tab within it is owner-only — isNavItemVisible only ever sees
  // the path, not the ?tab= query string, so it can't tell this item
  // apart from any other /settings link.
  const visibleNavItems = navItems
    .filter((item) => isNavItemVisible(item.href, accountRole, profileLoading))
    .filter((item) => item.href !== "/settings?tab=ai" || accountRole !== "admin");
  const visibleReportNavItems = reportNavItems.filter((item) =>
    isNavItemVisible(item.href, accountRole, profileLoading),
  );
  const visibleBottomNavItems = bottomNavItems.filter((item) =>
    isNavItemVisible(item.href, accountRole, profileLoading),
  );

  // Um único item ativo no menu principal: o de prefixo mais longo que
  // casar com a rota (evita destacar Disparador e Blacklist juntos em
  // /disparador/blacklist). "Agente de IA" só fica ativo com ?tab=ai;
  // links de /settings ficam de fora aqui (o rodapé cuida deles).
  const isAiTab = pathname === "/settings" && searchParams.get("tab") === "ai";
  const activeNavHref = isAiTab
    ? "/settings?tab=ai"
    : longestMatchingHref(
        pathname,
        visibleNavItems
          .map((item) => item.href)
          .filter((href) => !href.startsWith("/settings")),
      );
  const activeReportHref = longestMatchingHref(
    pathname,
    visibleReportNavItems.map((item) => item.href),
  );
  const canSeeSettings = !!accountRole && canAccessRoute(accountRole, "/settings");
  const canSeeProfile = !!accountRole && canAccessRoute(accountRole, "/perfil");
  const homeHref = accountRole ? getDefaultRoute(accountRole) : "/dashboard";

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
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

  // Conteúdo dos botões extras injetados por papel (supervisor, mensagens
  // internas, trocar senha) — mesmo visual dos links, nos dois modos.
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
          className={navItemClass(rail, INACTIVE_ITEM)}
        >
          <Icon className="h-4 w-4 shrink-0" />
          {!rail && <span className="flex-1">{label}</span>}
          {unread > 0 &&
            (rail ? (
              <RailDot />
            ) : (
              <span
                aria-label={internalUnreadLabel}
                className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            ))}
        </button>
      </RailTooltip>
    </li>
  );

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label="Fechar menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: static, always visible — reset all the mobile framing.
          // A largura alterna entre expandido (w-60) e rail (w-16).
          "lg:static lg:z-0 lg:translate-x-0 lg:overflow-hidden lg:transition-[width] lg:will-change-auto",
          rail ? "lg:w-16" : "lg:w-60",
        )}
        aria-label="Navegação principal"
      >
        {/* Logo row. On mobile we put a close button here; on desktop
            it holds the collapse/expand toggle instead. */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-b border-border",
            rail ? "justify-center px-2" : "justify-between gap-2 px-4",
          )}
        >
          {!rail && (
            <Link href={homeHref} className="flex min-w-0 items-center gap-2">
              <DdmLogo showBackground />
              <span className="truncate text-sm font-semibold text-foreground">
                DDM CRM
              </span>
            </Link>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={rail ? "Expandir menu" : "Recolher menu"}
            aria-expanded={!rail}
            title={rail ? "Expandir menu (Ctrl+B)" : "Recolher menu (Ctrl+B)"}
            className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:flex"
          >
            {rail ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar menu"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <TooltipProvider>
        <nav className={cn("flex-1 overflow-x-hidden overflow-y-auto py-4", rail ? "px-2" : "px-3")}>
          <ul className="flex flex-col gap-1">
            {visibleNavItems.map((item) => {
              const isActive = item.href === activeNavHref;

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;
              const unreadLabel = `${totalUnread} conversa${totalUnread === 1 ? "" : "s"} não lida${totalUnread === 1 ? "" : "s"}`;

              return (
                <Fragment key={item.href}>
                  <li>
                    <RailTooltip enabled={rail} label={item.label}>
                      <Link
                        href={item.href}
                        aria-label={
                          rail
                            ? showUnreadDot
                              ? `${item.label} (${unreadLabel})`
                              : item.label
                            : undefined
                        }
                        aria-current={isActive ? "page" : undefined}
                        className={navItemClass(
                          rail,
                          isActive ? ACTIVE_ITEM : INACTIVE_ITEM,
                        )}
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!rail && <span className="flex-1">{item.label}</span>}
                        {!rail && item.beta && (
                          <span
                            aria-label="Recurso Beta"
                            className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-300"
                          >
                            Beta
                          </span>
                        )}
                        {showUnreadDot &&
                          (rail ? (
                            <RailDot />
                          ) : (
                            <span
                              aria-label={unreadLabel}
                              className="relative flex h-2 w-2"
                            >
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
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
                      {renderExtraButton("password-agent", "Trocar senha", KeyRound, () =>
                        setPasswordDialogOpen(true),
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
                    renderExtraButton("password-admin", "Trocar senha", KeyRound, () =>
                      setPasswordDialogOpen(true),
                    )}
                </Fragment>
              );
            })}

            {visibleReportNavItems.length > 0 && (
              <li>
                {/* No rail, clicar em Relatórios expande o menu já com o
                    grupo aberto — mais simples e robusto que um popover. */}
                <RailTooltip enabled={rail} label="Relatórios">
                  <button
                    type="button"
                    onClick={() => {
                      if (rail) {
                        setCollapsed(false);
                        setReportsOpen(true);
                      } else {
                        setReportsOpen((o) => !o);
                      }
                    }}
                    aria-label={rail ? "Relatórios (expandir menu)" : undefined}
                    aria-expanded={rail ? undefined : reportsOpen}
                    className={navItemClass(
                      rail,
                      isReportsActive
                        ? rail
                          ? ACTIVE_ITEM
                          : "text-primary"
                        : INACTIVE_ITEM,
                    )}
                  >
                    <BarChart2 className="h-4 w-4 shrink-0" />
                    {!rail && <span className="flex-1 text-left">Relatórios</span>}
                    {!rail &&
                      (reportsOpen ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      ))}
                  </button>
                </RailTooltip>
                {reportsOpen && !rail && (
                  <ul className="mt-1 flex flex-col gap-1 pl-4">
                    {visibleReportNavItems.map((item) => {
                      const isActive = item.href === activeReportHref;
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                              isActive ? ACTIVE_ITEM : INACTIVE_ITEM,
                            )}
                          >
                            <item.icon className="h-4 w-4" />
                            {item.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            )}
          </ul>

          {visibleBottomNavItems.length > 0 && (
            <div className="my-4 border-t border-border" />
          )}

          <ul className="flex flex-col gap-1">
            {visibleBottomNavItems.map((item) => {
              const isActive =
                item.href === "/settings"
                  ? matchesPrefix(pathname, item.href) && !isAiTab
                  : matchesPrefix(pathname, item.href);
              return (
                <li key={item.href}>
                  <RailTooltip enabled={rail} label={item.label}>
                    <Link
                      href={item.href}
                      aria-label={rail ? item.label : undefined}
                      aria-current={isActive ? "page" : undefined}
                      className={navItemClass(rail, isActive ? ACTIVE_ITEM : INACTIVE_ITEM)}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      {!rail && item.label}
                    </Link>
                  </RailTooltip>
                </li>
              );
            })}
          </ul>
        </nav>
        </TooltipProvider>

        {/* User section */}
        <div className={cn("shrink-0 border-t border-border", rail ? "p-2" : "p-3")}>
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. Oculto no rail. */}
          {!rail && showAccountStrip && account?.name ? (
            <div className="mb-2 flex items-center gap-2 px-3 text-xs text-muted-foreground">
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole ? (
                // Always render the chip — owners used to be
                // invisible here, which made them indistinguishable
                // from admins at a glance. Now everyone sees their
                // role (with a colour cue) regardless of tier.
                (() => {
                  const meta = ROLE_META[accountRole];
                  const Icon = meta.icon;
                  return (
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}
                    >
                      <Icon className="size-3" />
                      {meta.label}
                    </span>
                  );
                })()
              ) : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={rail ? `Conta: ${profile?.full_name ?? "Usuário"}` : undefined}
              title={rail ? (profile?.full_name ?? "Usuário") : undefined}
              className={cn(
                "flex w-full items-center rounded-lg text-left transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60",
                rail ? "justify-center p-1" : "gap-3 px-3 py-2",
              )}
            >
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? "Avatar"}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              {!rail && (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {profile?.full_name ?? "Usuário"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {profile?.email ?? ""}
                  </p>
                  {teamNames.length > 0 && (
                    <p className="truncate text-[11px] text-muted-foreground">
                      {teamNames.join(", ")}
                    </p>
                  )}
                </div>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align={rail ? "start" : "end"}
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              {canSeeProfile && (
                <DropdownMenuItem
                  render={
                    <Link
                      href="/perfil"
                      onClick={onClose}
                      className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                    />
                  }
                >
                  <User className="size-4" />
                  Meu Perfil
                </DropdownMenuItem>
              )}
              {/* Mesmo gate da rota (/settings é owner/admin) — antes o
                  item aparecia para agent/viewer e só redirecionava. */}
              {canSeeSettings && (
                <DropdownMenuItem
                  render={
                    <Link
                      href="/settings"
                      onClick={onClose}
                      className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                    />
                  }
                >
                  <Settings className="size-4" />
                  Configurações
                </DropdownMenuItem>
              )}
              {(canSeeProfile || canSeeSettings) && (
                <DropdownMenuSeparator className="bg-border" />
              )}
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
