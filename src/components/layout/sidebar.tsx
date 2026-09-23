"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import {
  Activity,
  BarChart2,
  ChevronDown,
  ChevronUp,
  Download,
  GitBranch,
  Headphones,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Megaphone,
  MessageSquare,
  Radio,
  Send,
  Settings,
  Shield,
  User,
  UserCheck,
  Users,
  UsersRound,
  Wifi,
  Workflow,
  X,
  Bot,
  HelpCircle,
} from "lucide-react";
import type { AccountRole } from "@/lib/auth/roles";
import { canAccessRoute, isRouteGated } from "@/lib/role-utils";
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

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/monitoramento", label: "Monitoramento", icon: Activity },
  { href: "/canais", label: "Canais", icon: Wifi },
  { href: "/inbox", label: "Conversas", icon: MessageSquare },
  { href: "/contacts", label: "Contatos", icon: Users },
  { href: "/pipelines", label: "Funis", icon: GitBranch },
  { href: "/flows", label: "Fluxos", icon: Workflow, beta: true },
  { href: "/disparador", label: "Disparador", icon: Megaphone },
  { href: "/equipes", label: "Equipes", icon: Users },
  { href: "/settings?tab=ai", label: "Agente de IA", icon: Bot },
];

// Sub-items of the "Relatórios" collapsible group — currently just
// Auditoria, but kept as a list (not a single link) since more report
// pages are the expected next additions here.
const reportNavItems: NavItem[] = [
  { href: "/relatorios/auditoria", label: "Auditoria", icon: Shield },
  { href: "/relatorios/atendimentos", label: "Atendimentos", icon: Headphones },
  { href: "/relatorios/agentes", label: "Agentes", icon: UserCheck },
  { href: "/relatorios/conversas", label: "Conversas", icon: MessageSquare },
  { href: "/relatorios/envio-em-lote", label: "Envio em lote", icon: Send },
  { href: "/relatorios/exportacoes", label: "Exportações", icon: Download },
];

const bottomNavItems = [
  { href: "/ajuda", label: "Central de Ajuda", icon: HelpCircle },
  { href: "/settings", label: "Configurações", icon: Settings },
];

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
  const visibleNavItems = navItems.filter((item) =>
    isNavItemVisible(item.href, accountRole, profileLoading),
  );
  const visibleReportNavItems = reportNavItems.filter((item) =>
    isNavItemVisible(item.href, accountRole, profileLoading),
  );
  const visibleBottomNavItems = bottomNavItems.filter((item) =>
    isNavItemVisible(item.href, accountRole, profileLoading),
  );

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

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label="Close menu"
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
          "lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none",
        )}
        aria-label="Primary"
      >
        {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <Link href="/dashboard" className="flex items-center gap-2">
            <DdmLogo showBackground />
            <span className="text-sm font-semibold text-foreground">
              DDM CRM
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {visibleNavItems.map((item) => {
              const isActive =
                item.href.includes("?tab=ai")
                  ? pathname === "/settings" && searchParams.get("tab") === "ai"
                  : pathname === item.href ||
                    (item.href !== "/dashboard" &&
                     !item.href.startsWith("/settings") &&
                     pathname.startsWith(item.href));

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;

              return (
                <Fragment key={item.href}>
                  <li>
                    <Link
                      href={item.href}
                      className={cn(
                        // Taller on mobile so fingers can hit the row reliably (≥44px).
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      <span className="flex-1">{item.label}</span>
                      {item.beta && (
                        <span
                          aria-label="Recurso Beta"
                          className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                        >
                          Beta
                        </span>
                      )}
                      {showUnreadDot && (
                        <span
                          aria-label={`${totalUnread} conversa${totalUnread === 1 ? "" : "s"} não lida${totalUnread === 1 ? "" : "s"}`}
                          className="relative flex h-2 w-2"
                        >
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                        </span>
                      )}
                    </Link>
                  </li>
                  {item.href === "/inbox" && accountRole === "agent" && (
                    <>
                      <li>
                        <button
                          type="button"
                          onClick={() => setInternalChatOpen(true)}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:py-2"
                        >
                          <Headphones className="h-4 w-4" />
                          <span className="flex-1">Conversar com supervisor</span>
                          {unreadInternalMessages > 0 && (
                            <span
                              aria-label={`${unreadInternalMessages} mensagem${unreadInternalMessages === 1 ? "" : "s"} não lida${unreadInternalMessages === 1 ? "" : "s"}`}
                              className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[#FF5706] px-1 text-[10px] font-semibold text-white"
                            >
                              {unreadInternalMessages > 99 ? "99+" : unreadInternalMessages}
                            </span>
                          )}
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          onClick={() => setPasswordDialogOpen(true)}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:py-2"
                        >
                          <KeyRound className="h-4 w-4" />
                          <span className="flex-1">Trocar senha</span>
                        </button>
                      </li>
                    </>
                  )}
                  {item.href === "/inbox" &&
                    (accountRole === "admin" || accountRole === "owner") && (
                      <li>
                        <button
                          type="button"
                          onClick={() => setInternalChatOpen(true)}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:py-2"
                        >
                          <Headphones className="h-4 w-4" />
                          <span className="flex-1">Mensagens internas</span>
                          {unreadInternalMessages > 0 && (
                            <span
                              aria-label={`${unreadInternalMessages} mensagem${unreadInternalMessages === 1 ? "" : "s"} não lida${unreadInternalMessages === 1 ? "" : "s"}`}
                              className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[#FF5706] px-1 text-[10px] font-semibold text-white"
                            >
                              {unreadInternalMessages > 99 ? "99+" : unreadInternalMessages}
                            </span>
                          )}
                        </button>
                      </li>
                    )}
                </Fragment>
              );
            })}

            {visibleReportNavItems.length > 0 && (
              <li>
                <button
                  type="button"
                  onClick={() => setReportsOpen((o) => !o)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                    isReportsActive
                      ? "text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <BarChart2 className="h-4 w-4" />
                  <span className="flex-1 text-left">Relatórios</span>
                  {reportsOpen ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </button>
                {reportsOpen && (
                  <ul className="mt-1 flex flex-col gap-1 pl-4">
                    {visibleReportNavItems.map((item) => {
                      const isActive = pathname.startsWith(item.href);
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            className={cn(
                              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                              isActive
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground",
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
                  ? pathname.startsWith(item.href) && searchParams.get("tab") !== "ai"
                  : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User section */}
        <div className="shrink-0 border-t border-border p-3">
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
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
            <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60">
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
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {profile?.full_name ?? "User"}
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
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              {accountRole !== "agent" && (
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
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                Configurações
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
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
