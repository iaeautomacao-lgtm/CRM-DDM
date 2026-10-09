"use client";

import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { usePermission } from "@/hooks/use-permission";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";
import {
  Search,
  ChevronDown,
  Plus,
  Loader2,
  SlidersHorizontal,
  X,
  AlertTriangle,
  Bell,
  BellOff,
  History,
  PanelLeftClose,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CONVERSATION_STATUS_LABELS_PLURAL } from "./status-labels";
import { MyHandledDrawer } from "./my-handled-drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  conversationMatchesFilters,
  parseInboxFilters,
  writeInboxFilters,
  type InboxChannel,
  type InboxFilters,
  type InboxStatus,
} from "@/lib/inbox/filters";
import { sectionTotal, shouldAutoLoadMore } from "@/lib/inbox/pagination";
import { INBOX_QUEUE_LABELS, inboxQueueSection } from "@/lib/inbox/queue-section";
import { PushNudge } from "./push-nudge";

// Lista do inbox (F2). Os dados vêm de /api/inbox/conversations, paginados
// e filtrados no servidor (RLS do usuário). Os filtros ficam na URL
// (?canal=&linha=&atendente=&equipe=&cliente=&campanha=&status=&q=), então
// um link já abre filtrado. O estado das conversas continua no
// InboxPage, que também aplica os eventos de tempo real; aqui só se
// decide o que da lista atual aparece com os filtros escolhidos.

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /** Opens the "Nova conversa" contact picker — omitted call sites just
   *  don't get the "+ Nova" button (it's also gated on role, see render). */
  onCreateConversation?: () => void;
  /** Recolhe a lista no desktop (item 9 do PRD 23). */
  onCollapse?: () => void;
  /** Avisos de conversa em espera ligados (item 14 do PRD 23). */
  alertsEnabled?: boolean;
  onToggleAlerts?: () => void;
}

const STATUS_OPTIONS: { label: string; value: InboxStatus }[] = [
  { label: "Em andamento", value: "active" },
  { label: "Não lidas", value: "unread" },
  { label: CONVERSATION_STATUS_LABELS_PLURAL.open, value: "open" },
  { label: CONVERSATION_STATUS_LABELS_PLURAL.pending, value: "pending" },
  { label: CONVERSATION_STATUS_LABELS_PLURAL.closed, value: "closed" },
];

const CHANNEL_TABS: { label: string; value: InboxChannel | null }[] = [
  { label: "Todos", value: null },
  { label: "WhatsApp", value: "whatsapp" },
  { label: "Webchat", value: "webchat" },
  { label: "Instagram", value: "instagram" },
  { label: "Messenger", value: "messenger" },
];

export const CHANNEL_BADGE: Record<string, { label: string; className: string }> = {
  whatsapp: { label: "WhatsApp", className: "text-emerald-400 [html[data-mode=light]_&]:text-emerald-700 bg-emerald-500/10 border-emerald-500/20" },
  webchat: { label: "Webchat", className: "text-cyan-400 [html[data-mode=light]_&]:text-cyan-700 bg-cyan-500/10 border-cyan-500/20" },
  instagram: { label: "Instagram", className: "text-pink-400 [html[data-mode=light]_&]:text-pink-700 bg-pink-500/10 border-pink-500/20" },
  messenger: { label: "Messenger", className: "text-blue-400 [html[data-mode=light]_&]:text-blue-700 bg-blue-500/10 border-blue-500/20" },
  sms: { label: "SMS", className: "text-violet-400 [html[data-mode=light]_&]:text-violet-700 bg-violet-500/10 border-violet-500/20" },
};

// Persisted independently per section so collapsing one doesn't touch
// the other.
const SECTION_STORAGE_KEY = {
  open: "inbox-section-open",
  pending: "inbox-section-pending",
} as const;

interface LineOption {
  id: string;
  channel_type: string;
  name: string;
  waha_session: string | null;
}
type NamedOption = { id: string; name: string };
type ClientOption = { id: string; name: string; color: string };
type StatusTotals = { open?: number | null; pending?: number | null };
type QueueTab = "me" | "unassigned" | "all";

function readSectionPref(key: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

/** Opções dos filtros (linhas, atendentes, equipes, clientes, campanhas). */
function useFilterOptions(accountId: string | null) {
  const [lines, setLines] = useState<LineOption[]>([]);
  const [agents, setAgents] = useState<NamedOption[]>([]);
  const [teams, setTeams] = useState<(NamedOption & { color: string | null })[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [campaigns, setCampaigns] = useState<NamedOption[]>([]);
  const [outcomes, setOutcomes] = useState<ClientOption[]>([]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const [linesRes, agentsRes, teamsRes, clientsRes, campaignsRes, outcomesRes] = await Promise.all([
        apiFetch("/api/lines").then((r) => (r.ok ? r.json() : { lines: [] })).catch(() => ({ lines: [] })),
        supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .eq("account_id", accountId)
          .in("account_role", ["agent", "supervisor", "admin", "owner"])
          .order("full_name"),
        supabase.from("teams").select("id, name, color").eq("account_id", accountId).order("name"),
        supabase.from("clients").select("id, name, color").eq("account_id", accountId).order("name"),
        // Campanhas que podem ter originado conversas (as mais recentes).
        supabase
          .from("campaigns")
          .select("id, nome")
          .eq("account_id", accountId)
          .order("created_at", { ascending: false })
          .limit(50),
        // Tabulações (tags de desfecho) para o filtro do item 11 do PRD 23.
        supabase.from("tags").select("id, name, color").eq("account_id", accountId).eq("kind", "outcome").order("name"),
      ]);
      if (cancelled) return;
      setLines(linesRes.lines ?? []);
      setAgents(
        (agentsRes.data ?? []).map((p: { user_id: string; full_name: string | null; email: string | null }) => ({
          id: p.user_id,
          name: p.full_name || p.email || "Atendente",
        }))
      );
      // teams.color (migration 280) pode ainda não existir no banco: sem ela,
      // busca de novo só id/nome — o filtro de equipe nunca some por isso.
      let teamRows = teamsRes.data as (NamedOption & { color?: string | null })[] | null;
      if (teamsRes.error) {
        const fallback = await supabase.from("teams").select("id, name").eq("account_id", accountId).order("name");
        if (cancelled) return;
        teamRows = (fallback.data ?? []) as NamedOption[];
      }
      setTeams((teamRows ?? []).map((t) => ({ ...t, color: t.color ?? null })));
      setClients((clientsRes.data ?? []) as ClientOption[]);
      setCampaigns(
        (campaignsRes.data ?? []).map((c: { id: string; nome: string }) => ({ id: c.id, name: c.nome }))
      );
      setOutcomes((outcomesRes.data ?? []) as ClientOption[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { lines, agents, teams, clients, campaigns, outcomes };
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onCreateConversation,
  onCollapse,
  alertsEnabled,
  onToggleAlerts,
}: ConversationListProps) {
  const { accountRole, accountId, user } = useAuth();
  const isAgent = accountRole === "agent";
  const canReply = usePermission("inbox.reply");
  const router = useRouter();
  const [myHandledOpen, setMyHandledOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseInboxFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  const filtersKey = useMemo(() => writeInboxFilters(new URLSearchParams(), filters).toString(), [filters]);

  const [searchDraft, setSearchDraft] = useState(filters.q);
  // Quando a URL muda por fora (voltar/avançar), o rascunho acompanha.
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (syncedQ !== filters.q) {
    setSyncedQ(filters.q);
    setSearchDraft(filters.q);
  }
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // Falha da carga inicial: antes virava "Nenhuma conversa encontrada" e o
  // operador achava que não havia atendimentos. 403 = sem permissão.
  const [loadError, setLoadError] = useState<"error" | "forbidden" | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [statusTotals, setStatusTotals] = useState<StatusTotals>({});
  // Totais das abas (null = contagem indisponível: a aba fica sem número).
  const [tabTotals, setTabTotals] = useState<Record<QueueTab, number | null>>({ me: null, unassigned: null, all: null });
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const options = useFilterOptions(accountId);

  const [openSectionExpanded, setOpenSectionExpanded] = useState<boolean>(() =>
    readSectionPref(SECTION_STORAGE_KEY.open)
  );
  const [pendingSectionExpanded, setPendingSectionExpanded] = useState<boolean>(() =>
    readSectionPref(SECTION_STORAGE_KEY.pending)
  );
  const toggleSection = useCallback((key: "open" | "pending") => {
    const setter = key === "open" ? setOpenSectionExpanded : setPendingSectionExpanded;
    setter((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SECTION_STORAGE_KEY[key], String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  /** Troca filtros mantendo os outros parâmetros (?c= da conversa aberta). */
  const setFilters = useCallback(
    (patch: Partial<InboxFilters>) => {
      const next = writeInboxFilters(new URLSearchParams(searchParams.toString()), { ...filters, ...patch });
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [filters, pathname, router, searchParams]
  );

  // Busca com espera de 300ms para não consultar a cada tecla.
  useEffect(() => {
    if (searchDraft === filters.q) return;
    const timer = window.setTimeout(() => setFilters({ q: searchDraft }), 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft, filters.q, setFilters]);

  // Keep the latest callback in a ref so the fetch effect below keeps a
  // stable identity (the parent's callback changes with the deep link).
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  });

  // Primeira página + contadores. Refaz ao mudar filtro ou quando o pai
  // pede (reconexão do realtime / aba volta a ficar visível).
  // As abas Minhas / Fila / Todas usam o MESMO /api/inbox/counts com o
  // atendente trocado: "todas" (sem atendente) dá Fila (sem atendente) e
  // Todas (soma); "me" dá Minhas. Só busca a variação que falta.
  const countKeys = useMemo(() => {
    const base = writeInboxFilters(new URLSearchParams(), { ...filters, atendente: null }).toString();
    const mine = writeInboxFilters(new URLSearchParams(), { ...filters, atendente: "me" }).toString();
    return { base, mine };
  }, [filters]);
  useEffect(() => {
    let cancelled = false;
    const fetchCounts = (qs: string) =>
      apiFetch(`/api/inbox/counts?${qs}`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})) as Promise<{ unread?: Record<string, number>; status?: StatusTotals }>;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [listRes, counts, baseCounts, mineCounts] = await Promise.all([
          apiFetch(`/api/inbox/conversations?${filtersKey}`),
          fetchCounts(filtersKey),
          countKeys.base === filtersKey ? null : fetchCounts(countKeys.base),
          countKeys.mine === filtersKey ? null : fetchCounts(countKeys.mine),
        ]);
        const list = await listRes.json().catch(() => ({}));
        if (cancelled) return;
        if (!listRes.ok) {
          setLoadError(listRes.status === 403 ? "forbidden" : "error");
          throw new Error(list.error ?? `HTTP ${listRes.status}`);
        }
        onConversationsLoadedRef.current(list.conversations ?? []);
        setNextCursor(list.next_cursor ?? null);
        setUnread(counts.unread ?? {});
        setStatusTotals(counts.status ?? {});
        const base = (baseCounts ?? counts).status ?? {};
        const mine = (mineCounts ?? counts).status ?? {};
        setTabTotals({
          me: mine.open ?? null,
          unassigned: base.pending ?? null,
          all: base.open != null && base.pending != null ? base.open + base.pending : null,
        });
        setLoadMoreFailed(false);
      } catch (err) {
        console.error("Failed to fetch conversations:", err);
        if (!cancelled) setLoadError((cur) => cur ?? "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filtersKey, resyncToken, countKeys, retryKey]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const res = await apiFetch(
        `/api/inbox/conversations?${filtersKey}${filtersKey ? "&" : ""}cursor=${encodeURIComponent(nextCursor)}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const known = new Set(conversationsRef.current.map((c) => c.id));
      onConversationsLoadedRef.current([
        ...conversationsRef.current,
        ...((json.conversations ?? []) as Conversation[]).filter((c) => !known.has(c.id)),
      ]);
      setNextCursor(json.next_cursor ?? null);
    } catch (err) {
      console.error("Failed to load more conversations:", err);
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [filtersKey, nextCursor, loadingMore]);

  // Rolagem infinita: ao aproximar do fim da lista carrega a próxima página.
  // O observer é recriado a cada página, então se o sentinela continuar
  // visível (página curta/filtro client-side) ele dispara de novo.
  const autoLoad = shouldAutoLoadMore({ nextCursor, loading, loadingMore, failed: loadMoreFailed });
  useEffect(() => {
    const el = sentinelRef.current;
    if (!autoLoad || !el || typeof IntersectionObserver === "undefined") return;
    const root = el.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { root, rootMargin: "0px 0px 400px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoLoad, loadMore]);

  // Conversas que chegam pelo tempo real entram na lista do pai sem
  // passar pelos filtros: aqui só fica o que casa com eles.
  const selectedLine = useMemo(
    () => options.lines.find((l) => l.id === filters.linha) ?? null,
    [options.lines, filters.linha]
  );
  const visible = useMemo(() => {
    const ctx = { userId: user?.id ?? null, line: selectedLine };
    return [...conversations]
      .filter((c) => conversationMatchesFilters(c, filters, ctx))
      .sort((a, b) => {
        const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
        const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
        return timeB - timeA;
      });
  }, [conversations, filters, selectedLine, user?.id]);

  // Fila operacional por atribuição humana (lib/inbox/queue-section): com
  // atendente = Em atendimento; sem atendente = Em espera. Como no
  // protótipo, a espera vem primeiro e ordenada pela MAIOR espera (última
  // mensagem do cliente mais antiga); o atendimento, pela mais recente.
  const grouped = filters.status === "active";
  const openGroup = useMemo(
    () => visible.filter((c) => inboxQueueSection(c) === "attending"),
    [visible],
  );
  const pendingGroup = useMemo(
    () =>
      visible
        .filter((c) => inboxQueueSection(c) === "waiting")
        .sort((a, b) => waitingSince(a) - waitingSince(b)),
    [visible],
  );

  const clientsById = useMemo(() => new Map(options.clients.map((c) => [c.id, c])), [options.clients]);
  const agentsById = useMemo(() => new Map(options.agents.map((a) => [a.id, a.name])), [options.agents]);
  const teamsById = useMemo(() => new Map(options.teams.map((t) => [t.id, t])), [options.teams]);
  const linesForTab = useMemo(
    () =>
      options.lines.filter((l) =>
        filters.canal === null
          ? l.channel_type !== "webchat"
          : filters.canal === "webchat"
            ? l.channel_type === "whatsapp"
            : l.channel_type === filters.canal
      ),
    [options.lines, filters.canal]
  );

  // Aba ativa: Minhas = atendente "me"; Fila = sem atendente; Todas = sem
  // filtro de atendente. Um atendente específico (filtro do supervisor)
  // não marca nenhuma aba.
  const activeTab: QueueTab | null =
    filters.atendente === "me" ? "me" : filters.atendente === "unassigned" ? "unassigned" : filters.atendente === null ? "all" : null;
  const tabs: { id: QueueTab; label: string }[] = [
    { id: "me", label: "Minhas" },
    { id: "unassigned", label: "Fila" },
    { id: "all", label: "Todas" },
  ];
  const selectTab = (tab: QueueTab) => setFilters({ atendente: tab === "all" ? null : tab });

  // Chips dos filtros ativos (o atendente da aba não conta como filtro).
  const chips: { key: string; label: string; remove: () => void }[] = [];
  if (filters.canal) {
    chips.push({ key: "canal", label: CHANNEL_BADGE[filters.canal]?.label ?? filters.canal, remove: () => setFilters({ canal: null, linha: null }) });
  }
  if (filters.status !== "active") {
    chips.push({ key: "status", label: STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ?? "Status", remove: () => setFilters({ status: "active" }) });
  }
  if (activeTab === null && filters.atendente) {
    chips.push({ key: "atendente", label: agentsById.get(filters.atendente) ?? "Atendente", remove: () => setFilters({ atendente: null }) });
  }
  if (filters.linha) {
    chips.push({ key: "linha", label: options.lines.find((l) => l.id === filters.linha)?.name ?? "Linha", remove: () => setFilters({ linha: null }) });
  }
  if (filters.equipe) {
    chips.push({ key: "equipe", label: options.teams.find((t) => t.id === filters.equipe)?.name ?? "Equipe", remove: () => setFilters({ equipe: null }) });
  }
  if (filters.cliente) {
    chips.push({ key: "cliente", label: options.clients.find((c) => c.id === filters.cliente)?.name ?? "Cliente", remove: () => setFilters({ cliente: null }) });
  }
  if (filters.campanha) {
    chips.push({ key: "campanha", label: options.campaigns.find((c) => c.id === filters.campanha)?.name ?? "Campanha", remove: () => setFilters({ campanha: null }) });
  }
  if (filters.tabulacao) {
    chips.push({ key: "tabulacao", label: options.outcomes.find((o) => o.id === filters.tabulacao)?.name ?? "Tabulação", remove: () => setFilters({ tabulacao: null }) });
  }
  const activeFilterCount = chips.length;
  const clearFilters = () =>
    setFilters({ canal: null, status: "active", atendente: activeTab === null ? null : filters.atendente, linha: null, equipe: null, cliente: null, campanha: null, tabulacao: null });
  const clearAll = () => {
    setSearchDraft("");
    setFilters({ q: "", canal: null, status: "active", atendente: null, linha: null, equipe: null, cliente: null, campanha: null, tabulacao: null });
  };

  const renderItems = (items: Conversation[]) => (
    <div className="ddm-stagger flex flex-col">
      {items.map((conv) => (
        <ConversationItem
          key={conv.id}
          conversation={conv}
          isActive={conv.id === activeConversationId}
          onSelect={onSelect}
          client={conv.client_id ? clientsById.get(conv.client_id) ?? null : null}
          assigneeName={
            conv.assigned_agent_id && conv.assigned_agent_id !== user?.id
              ? agentsById.get(conv.assigned_agent_id) ?? null
              : null
          }
          showStatus={!grouped}
          team={conv.team_id ? teamsById.get(conv.team_id) ?? null : null}
        />
      ))}
    </div>
  );

  const sections = grouped
    ? [
        {
          key: "pending" as const,
          label: CONVERSATION_STATUS_LABELS_PLURAL.pending,
          dot: "bg-warning",
          items: pendingGroup,
          total: sectionTotal(pendingGroup.length, filters.q ? null : statusTotals.pending ?? null, Boolean(nextCursor)),
          expanded: pendingSectionExpanded,
          empty: "Ninguém aguardando atendimento.",
          show: activeTab !== "me",
        },
        {
          key: "open" as const,
          label: CONVERSATION_STATUS_LABELS_PLURAL.open,
          dot: "bg-success",
          items: openGroup,
          total: sectionTotal(openGroup.length, filters.q ? null : statusTotals.open ?? null, Boolean(nextCursor)),
          expanded: openSectionExpanded,
          empty: "Nenhuma conversa em atendimento.",
          show: activeTab !== "unassigned",
        },
      ].filter((s) => s.show)
    : [];

  return (
    // Lista de triagem do redesenho DDM (protótipo "Inbox Operacional"):
    // abas da fila, busca + filtros com chips, seções por fila e itens em
    // três linhas (contato · prévia · cliente/canal/atendente).
    <section aria-label="Lista de conversas" className="flex h-full w-full flex-col border-r border-border bg-card lg:w-[288px] xl:w-[320px]">
      <PushNudge />
      <div className="flex flex-col gap-2.5 border-b border-border px-3.5 pb-2.5 pt-3.5">
        <div className="flex items-center gap-1.5">
        <div className="flex flex-1 gap-0.5 rounded-lg bg-card-2 p-[3px]" role="group" aria-label="Fila">
          {tabs.map((tab) => {
            const on = activeTab === tab.id;
            const count = tabTotals[tab.id];
            const alert = on && tab.id === "unassigned" && (count ?? 0) > 0;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={on}
                onClick={() => selectTab(tab.id)}
                className={cn(
                  "flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-md text-[12.5px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
                  on
                    ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.12),0_0_0_1px_var(--border)]"
                    : "text-foreground-2 hover:text-foreground",
                )}
              >
                {tab.label}
                {count !== null && (
                  <span
                    className={cn(
                      "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-[11px] tabular-nums",
                      alert ? "bg-warning-soft text-warning" : "bg-surface-3 text-foreground-2",
                    )}
                  >
                    {count > 999 ? "999+" : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
          {onToggleAlerts && (
            <button
              type="button"
              onClick={onToggleAlerts}
              aria-pressed={!!alertsEnabled}
              aria-label={alertsEnabled ? "Desligar avisos de conversa em espera" : "Ligar avisos de conversa em espera"}
              title={alertsEnabled ? "Avisos de conversa em espera: ligados" : "Avisos de conversa em espera: desligados"}
              className={cn(
                "flex size-[30px] shrink-0 items-center justify-center rounded-md hover:bg-surface-hover",
                alertsEnabled ? "text-primary-text" : "text-muted-foreground",
              )}
            >
              {alertsEnabled ? <Bell className="size-4" aria-hidden="true" /> : <BellOff className="size-4" aria-hidden="true" />}
            </button>
          )}
          {/* Item 17 do PRD 23: o que eu atendi e transferi (só consulta). */}
          <button
            type="button"
            onClick={() => setMyHandledOpen(true)}
            aria-label="Meus atendidos: conversas que você transferiu"
            title="Meus atendidos (conversas que você transferiu)"
            className="flex size-[30px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          >
            <History className="size-4" aria-hidden="true" />
          </button>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Recolher lista de conversas"
              title="Recolher lista (mais espaço para a conversa)"
              className="hidden size-[30px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground lg:flex"
            >
              <PanelLeftClose className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="flex gap-2">
          <label className="relative flex flex-1 items-center">
            <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              aria-label="Buscar conversas por nome ou telefone"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Buscar nome ou telefone"
              className="h-[34px] w-full rounded-md border border-border bg-card pl-[34px] pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
            />
          </label>
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12.5px] font-medium hover:bg-surface-hover",
                    activeFilterCount > 0 ? "border-primary-soft-2 text-primary-text" : "border-border text-foreground-2",
                  )}
                  aria-label={activeFilterCount > 0 ? `Filtros (${activeFilterCount} ativos)` : "Filtros"}
                />
              }
            >
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              Filtros
              {activeFilterCount > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10.5px] font-bold text-primary-foreground" aria-hidden="true">
                  {activeFilterCount}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[280px] gap-3 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-foreground">Filtros</span>
                {activeFilterCount > 0 && (
                  <button type="button" onClick={clearFilters} className="rounded px-1 py-1 text-xs font-semibold text-primary-text hover:underline">
                    Limpar
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Canal</span>
                <div className="flex flex-wrap gap-1.5">
                  {CHANNEL_TABS.map((tab) => {
                    const on = filters.canal === tab.value;
                    const count = unread[tab.value ?? "all"] ?? 0;
                    return (
                      <button
                        key={tab.label}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setFilters({ canal: tab.value, linha: null })}
                        aria-label={count > 0 ? `${tab.label} (${count} não lidas)` : tab.label}
                        className={cn(
                          "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium",
                          on ? "border-primary-soft-2 bg-primary-soft text-primary-text" : "border-border bg-card text-foreground-2 hover:bg-surface-hover",
                        )}
                      >
                        {tab.label}
                        {count > 0 && <span className="tabular-nums opacity-80" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <FilterMenu
                  title="Status"
                  label={STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ?? ""}
                  options={STATUS_OPTIONS.map((o) => ({ id: o.value, name: o.label }))}
                  value={filters.status}
                  highlighted={filters.status !== "active"}
                  onChange={(v) => setFilters({ status: (v ?? "active") as InboxStatus })}
                />
                {!isAgent && options.agents.length > 0 && (
                  <FilterMenu
                    title="Atendente"
                    label={activeTab === null && filters.atendente ? agentsById.get(filters.atendente) ?? "Atendente" : "Pela aba"}
                    options={options.agents}
                    value={activeTab === null ? filters.atendente : null}
                    onChange={(v) => setFilters({ atendente: v })}
                    allLabel="Pela aba (Minhas / Fila / Todas)"
                  />
                )}
                {linesForTab.length > 0 && (
                  <FilterMenu
                    title="Linha"
                    label={linesForTab.find((l) => l.id === filters.linha)?.name ?? "Todas"}
                    options={linesForTab.map((l) => ({ id: l.id, name: l.name }))}
                    value={filters.linha}
                    onChange={(v) => setFilters({ linha: v })}
                    allLabel="Todas as linhas"
                  />
                )}
                {!isAgent && options.teams.length > 0 && (
                  <FilterMenu
                    title="Equipe"
                    label={options.teams.find((t) => t.id === filters.equipe)?.name ?? "Todas"}
                    options={options.teams}
                    value={filters.equipe}
                    onChange={(v) => setFilters({ equipe: v })}
                    allLabel="Todas as equipes"
                  />
                )}
                {options.clients.length > 0 && (
                  <FilterMenu
                    title="Cliente"
                    label={options.clients.find((c) => c.id === filters.cliente)?.name ?? "Todos"}
                    options={options.clients}
                    value={filters.cliente}
                    onChange={(v) => setFilters({ cliente: v })}
                    allLabel="Todos os clientes"
                  />
                )}
                {options.campaigns.length > 0 && (
                  <FilterMenu
                    title="Campanha"
                    label={options.campaigns.find((c) => c.id === filters.campanha)?.name ?? "Todas"}
                    options={options.campaigns}
                    value={filters.campanha}
                    onChange={(v) => setFilters({ campanha: v })}
                    allLabel="Todas as campanhas"
                  />
                )}
                {options.outcomes.length > 0 && (
                  <FilterMenu
                    title="Tabulação"
                    label={options.outcomes.find((o) => o.id === filters.tabulacao)?.name ?? "Todas"}
                    options={options.outcomes}
                    value={filters.tabulacao}
                    // Tabulação só existe em conversa encerrada (item 11 do PRD 23).
                    onChange={(v) => setFilters(v ? { tabulacao: v, status: "closed" } : { tabulacao: null })}
                    allLabel="Todas as tabulações"
                  />
                )}
              </div>
            </PopoverContent>
          </Popover>
          {onCreateConversation && canReply && (
            <button
              type="button"
              onClick={onCreateConversation}
              className="flex size-[34px] shrink-0 items-center justify-center rounded-md border border-border bg-card text-foreground-2 hover:bg-surface-hover hover:text-foreground"
              aria-label="Nova conversa"
              title="Nova conversa"
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {chips.length > 0 && (
          <div className="flex animate-ddm-fade flex-wrap gap-1.5">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.remove}
                aria-label={`Remover filtro ${chip.label}`}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-primary-soft-2 bg-primary-soft pl-[9px] pr-1.5 text-xs font-medium text-primary-text"
              >
                <span className="max-w-[160px] truncate">{chip.label}</span>
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space (issue #229). */}
      {/* Falha ao atualizar com a lista anterior ainda na tela: avisa que
          ela pode estar desatualizada, sem escondê-la. */}
      {!loading && loadError === "error" && visible.length > 0 && (
        <div role="alert" className="flex items-center gap-2 border-b border-border bg-danger-soft px-3.5 py-2 text-[12px] text-foreground">
          <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
          <span className="min-w-0 flex-1">Não foi possível atualizar a lista.</span>
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            className="shrink-0 font-semibold text-primary-text hover:underline"
          >
            Tentar de novo
          </button>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex flex-col" role="status" aria-busy="true">
            <span className="sr-only">Carregando conversas…</span>
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex gap-3 border-b border-border-soft px-3.5 py-3" aria-hidden="true">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-2 pt-0.5">
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-2.5 w-full" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : loadError && visible.length === 0 ? (
          <div role="alert" className="flex animate-ddm-fade flex-col items-center gap-1.5 px-6 py-12 text-center">
            <AlertTriangle className="size-4 text-danger" aria-hidden="true" />
            <p className="text-[13px] font-semibold text-foreground">
              {loadError === "forbidden" ? "Sem permissão para ver estas conversas" : "Não foi possível carregar as conversas"}
            </p>
            <p className="text-[12.5px] text-muted-foreground">
              {loadError === "forbidden"
                ? "Peça a um administrador para revisar o seu perfil."
                : "Verifique a conexão e tente de novo."}
            </p>
            {loadError === "error" && (
              <button
                type="button"
                onClick={() => setRetryKey((k) => k + 1)}
                className="mt-1.5 h-[30px] rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground hover:bg-surface-hover"
              >
                Tentar de novo
              </button>
            )}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex animate-ddm-fade flex-col items-center gap-1.5 px-6 py-12 text-center">
            <Search className="size-4 text-muted-foreground" aria-hidden="true" />
            <p className="text-[13px] font-semibold text-foreground">Nenhuma conversa encontrada</p>
            <p className="text-[12.5px] text-muted-foreground">Ajuste a busca ou limpe os filtros.</p>
            {(activeFilterCount > 0 || filters.q || activeTab !== "all") && (
              <button
                type="button"
                onClick={clearAll}
                className="mt-1.5 h-[30px] rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground hover:bg-surface-hover"
              >
                Limpar filtros
              </button>
            )}
          </div>
        ) : grouped ? (
          <div className="flex flex-col">
            {sections.map((section) => (
              <div key={section.key}>
                <SectionHeader
                  label={section.label}
                  dot={section.dot}
                  count={section.total}
                  expanded={section.expanded}
                  onToggle={() => toggleSection(section.key)}
                />
                {section.expanded &&
                  (section.items.length === 0 ? (
                    <p className="px-4 py-3.5 text-[12.5px] text-muted-foreground">{section.empty}</p>
                  ) : (
                    renderItems(section.items)
                  ))}
              </div>
            ))}
          </div>
        ) : (
          renderItems(visible)
        )}
        {!loading && nextCursor && (
          <div ref={sentinelRef} className="p-3">
            {loadMoreFailed ? (
              <Button variant="ghost" size="sm" className="w-full text-xs" onClick={loadMore}>
                Erro ao carregar. Tentar novamente
              </Button>
            ) : (
              <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Carregando…
              </div>
            )}
          </div>
        )}
      </ScrollArea>
      <MyHandledDrawer open={myHandledOpen} onOpenChange={setMyHandledOpen} />
    </section>
  );
}

/** Desde quando o cliente espera (ms): última mensagem dele; sem ela, a da conversa. */
function waitingSince(c: Conversation): number {
  const iso = c.last_customer_message_at ?? c.last_message_at;
  return iso ? Date.parse(iso) : Number.POSITIVE_INFINITY;
}

/** Menu de filtro com opção "todos" (quando `allLabel` é passado). */
function FilterMenu({
  title,
  label,
  options,
  value,
  onChange,
  allLabel,
  highlighted,
}: {
  /** Nome do filtro ("Status", "Linha"…), à esquerda da linha. */
  title: string;
  /** Valor atual por extenso. */
  label: string;
  options: NamedOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  allLabel?: string;
  /** Força o destaque de "filtro ativo" (status fora do padrão). */
  highlighted?: boolean;
}) {
  const active = highlighted ?? Boolean(value && allLabel);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${title}: ${label}`}
        className="flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-[13px] hover:bg-surface-hover"
      >
        <span className="shrink-0 text-muted-foreground">{title}</span>
        <span className={cn("flex min-w-0 items-center gap-1", active ? "font-medium text-primary-text" : "text-foreground")}>
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {allLabel && (
          <DropdownMenuItem
            onClick={() => onChange(null)}
            className={cn("text-[13px]", value === null ? "text-primary-text" : "text-popover-foreground")}
          >
            {allLabel}
          </DropdownMenuItem>
        )}
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={cn("text-[13px]", value === opt.id ? "text-primary-text" : "text-popover-foreground")}
          >
            {opt.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Cabeçalho fixo de uma seção da fila ("Em espera" / "Em atendimento"),
 *  com a bolinha de cor da fila (item 15 do PRD 23). */
function SectionHeader({
  label,
  dot,
  count,
  expanded,
  onToggle,
}: {
  label: string;
  dot: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sticky top-0 z-[2] flex h-8 w-full items-center gap-2 border-b border-border bg-card px-3.5 text-left hover:bg-surface-hover"
      aria-expanded={expanded}
      data-no-ripple
    >
      <ChevronDown
        aria-hidden="true"
        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-ddm", !expanded && "-rotate-90")}
      />
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden="true" />
      <span className="text-xs font-semibold text-foreground-2">{label}</span>
      <span className="text-xs font-medium tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Cliente da linha (quadradinho com a cor e o nome). */
  client: ClientOption | null;
  /** Atendente da conversa quando não é o usuário logado (item 13 do PRD 23). */
  assigneeName: string | null;
  /** Mostra o selo da fila no item (lista sem seções — item 15 do PRD 23). */
  showStatus: boolean;
  /** Equipe da conversa: a cor dela marca o avatar (item 12 do PRD 23). */
  team: { name: string; color: string | null } | null;
}

/** Minutos que o cliente espera sem atendente (null se não está esperando). */
function waitingMinutes(c: Conversation): number | null {
  if (c.assigned_agent_id || c.status === "closed" || !c.last_customer_message_at) return null;
  return Math.floor((Date.now() - Date.parse(c.last_customer_message_at)) / 60_000);
}

/** "5 min", "2 h", "3 d". */
function shortDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** Tempo compacto desde a última mensagem: "agora", "5 min", "2 h", "3 d";
 *  a partir de 7 dias mostra a data (dd/MM/yy). */
function compactTimeAgo(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60 * 24 * 7) return shortDuration(minutes);
  return format(date, "dd/MM/yy", { locale: ptBR });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

const QUEUE_DOT: Record<string, string> = {
  waiting: "bg-warning",
  attending: "bg-success",
  closed: "bg-muted-foreground",
};

function ConversationItem({ conversation, isActive, onSelect, client, assigneeName, showStatus, team }: ConversationItemProps) {
  const { accountId } = useAuth();
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Desconhecido";
  const channelLabel = CHANNEL_BADGE[conversation.channel_type ?? "whatsapp"]?.label ?? "WhatsApp";
  const unread = conversation.unread_count > 0;
  const waitMin = waitingMinutes(conversation);
  const waiting = waitMin !== null && waitMin >= 5;
  const negative = conversation.sentiment === "negative";
  const queueSection = inboxQueueSection(conversation);
  const queueLabel = INBOX_QUEUE_LABELS[queueSection];

  const time = waiting
    ? `aguarda ${shortDuration(waitMin)}`
    : conversation.last_message_at
      ? compactTimeAgo(conversation.last_message_at)
      : "";
  // Tooltip com a forma longa em pt-BR ("há 3 dias").
  const timeTitle = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), { addSuffix: true, locale: ptBR })
    : undefined;

  return (
    <button
      type="button"
      onClick={() => onSelect(conversation)}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex w-full gap-3 border-b border-l-2 border-b-border-soft py-3 pl-3 pr-3.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
        isActive ? "border-l-primary bg-selected" : "border-l-transparent hover:bg-surface-hover",
      )}
    >
      <span
        className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-[12.5px] font-semibold text-foreground-2"
        aria-hidden="true"
        title={team?.color ? `Equipe: ${team.name}` : undefined}
        // Anel na cor da equipe (paleta fechada da migration 280).
        style={team?.color ? { boxShadow: `0 0 0 2px var(--card), 0 0 0 4px ${team.color}` } : undefined}
      >
        {contact?.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            // Proxy por telefone só existe para WhatsApp.
            src={
              contact.phone && accountId
                ? `/api/whatsapp/contacts/avatar?phone=${encodeURIComponent(contact.phone.replace(/^\+/, "").replace(/\s/g, ""))}&account_id=${accountId}`
                : contact.avatar_url
            }
            alt=""
            className="size-9 object-cover"
          />
        ) : (
          initialsOf(displayName)
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[13.5px] text-foreground", unread ? "font-bold" : "font-semibold")}>
            {displayName}
          </span>
          <span
            className={cn(
              "shrink-0 whitespace-nowrap text-[11.5px] tabular-nums",
              waiting
                ? cn("font-semibold", waitMin >= 30 ? "text-destructive" : "text-warning")
                : unread
                  ? "font-semibold text-primary-text"
                  : "text-muted-foreground",
            )}
            title={timeTitle}
          >
            {time}
          </span>
        </span>

        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", unread ? "text-foreground" : "text-foreground-2")}>
            {conversation.last_message_text || "Nenhuma mensagem ainda"}
          </span>
          {negative && (
            <span
              className="size-[7px] shrink-0 rounded-full bg-destructive"
              role="img"
              aria-label="Sentimento negativo"
              title="Sentimento negativo"
            />
          )}
          {unread && (
            <span className="inline-flex h-[22px] min-w-5 shrink-0 animate-ddm-pop items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold tabular-nums text-primary-foreground">
              {conversation.unread_count}
              <span className="sr-only"> não lidas</span>
            </span>
          )}
        </span>

        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {client && (
            <>
              <span className="size-[7px] shrink-0 rounded-[2px]" style={{ backgroundColor: client.color }} aria-hidden="true" />
              <span className="min-w-0 truncate" title={`Cliente: ${client.name}`}>{client.name}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="shrink-0">{channelLabel}</span>
          {team && <span className="sr-only">Equipe: {team.name}.</span>}
          {assigneeName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate" title={`Atendente: ${assigneeName}`}>
                <span className="sr-only">Atendente: </span>
                {assigneeName}
              </span>
            </>
          )}
          {showStatus ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium text-foreground-2">
              <span className={cn("size-1.5 rounded-full", QUEUE_DOT[queueSection])} aria-hidden="true" />
              {queueLabel}
            </span>
          ) : (
            <span className="sr-only">Status: {queueLabel}</span>
          )}
        </span>
      </span>
    </button>
  );
}
