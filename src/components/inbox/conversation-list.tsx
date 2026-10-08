"use client";

import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";

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
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Input } from "@/components/ui/input";
import { CONVERSATION_STATUS_LABELS_PLURAL } from "./status-labels";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  whatsapp: { label: "WhatsApp", className: "text-emerald-600 bg-emerald-500/10 border-emerald-500/20" },
  webchat: { label: "Webchat", className: "text-cyan-600 bg-cyan-500/10 border-cyan-500/20" },
  instagram: { label: "Instagram", className: "text-pink-600 bg-pink-500/10 border-pink-500/20" },
  messenger: { label: "Messenger", className: "text-blue-600 bg-blue-500/10 border-blue-500/20" },
  sms: { label: "SMS", className: "text-violet-600 bg-violet-500/10 border-violet-500/20" },
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
  const [teams, setTeams] = useState<NamedOption[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [campaigns, setCampaigns] = useState<NamedOption[]>([]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const [linesRes, agentsRes, teamsRes, clientsRes, campaignsRes] = await Promise.all([
        apiFetch("/api/lines").then((r) => (r.ok ? r.json() : { lines: [] })).catch(() => ({ lines: [] })),
        supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .eq("account_id", accountId)
          .in("account_role", ["agent", "admin", "owner"])
          .order("full_name"),
        supabase.from("teams").select("id, name").eq("account_id", accountId).order("name"),
        supabase.from("clients").select("id, name, color").eq("account_id", accountId).order("name"),
        // Campanhas que podem ter originado conversas (as mais recentes).
        supabase
          .from("campaigns")
          .select("id, nome")
          .eq("account_id", accountId)
          .order("created_at", { ascending: false })
          .limit(50),
      ]);
      if (cancelled) return;
      setLines(linesRes.lines ?? []);
      setAgents(
        (agentsRes.data ?? []).map((p: { user_id: string; full_name: string | null; email: string | null }) => ({
          id: p.user_id,
          name: p.full_name || p.email || "Atendente",
        }))
      );
      setTeams((teamsRes.data ?? []) as NamedOption[]);
      setClients((clientsRes.data ?? []) as ClientOption[]);
      setCampaigns(
        (campaignsRes.data ?? []).map((c: { id: string; nome: string }) => ({ id: c.id, name: c.nome }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { lines, agents, teams, clients, campaigns };
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onCreateConversation,
}: ConversationListProps) {
  const { accountRole, accountId, user } = useAuth();
  const isAgent = accountRole === "agent";
  const router = useRouter();
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
  const [statusTotals, setStatusTotals] = useState<{ open?: number; pending?: number }>({});
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

  // Primeira página + contadores das abas. Refaz ao mudar filtro ou
  // quando o pai pede (reconexão do realtime / aba volta a ficar visível).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [listRes, countsRes] = await Promise.all([
          apiFetch(`/api/inbox/conversations?${filtersKey}`),
          apiFetch(`/api/inbox/counts?${filtersKey}`),
        ]);
        const list = await listRes.json();
        const counts = await countsRes.json().catch(() => ({}));
        if (cancelled) return;
        if (!listRes.ok) throw new Error(list.error ?? `HTTP ${listRes.status}`);
        onConversationsLoadedRef.current(list.conversations ?? []);
        setNextCursor(list.next_cursor ?? null);
        setUnread(counts.unread ?? {});
        setStatusTotals(counts.status ?? {});
        setLoadMoreFailed(false);
      } catch (err) {
        console.error("Failed to fetch conversations:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filtersKey, resyncToken]);

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

  const grouped = filters.status === "active";
  // A fila do operador é determinada por atribuição humana. Isso evita
  // pending com assigned_agent_id aparecer em "Em espera" e open sem
  // atendente aparecer como se já estivesse em atendimento.
  const openGroup = useMemo(
    () => visible.filter((c) => inboxQueueSection(c) === "attending"),
    [visible],
  );
  const pendingGroup = useMemo(
    () => visible.filter((c) => inboxQueueSection(c) === "waiting"),
    [visible],
  );

  const clientsById = useMemo(() => new Map(options.clients.map((c) => [c.id, c])), [options.clients]);
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

  // Filtros do popover (canal e busca ficam fora, já visíveis na barra).
  const activeFilterCount =
    (filters.status !== "active" ? 1 : 0) +
    [filters.atendente, filters.linha, filters.equipe, filters.cliente, filters.campanha].filter((v) => v !== null)
      .length;
  const clearFilters = () =>
    setFilters({ status: "active", atendente: null, linha: null, equipe: null, cliente: null, campanha: null });

  const agentLabel = (() => {
    if (filters.atendente === "me") return "Minhas";
    if (filters.atendente === "unassigned") return isAgent ? "Fila da equipe" : "Sem atendente";
    if (filters.atendente) return options.agents.find((a) => a.id === filters.atendente)?.name ?? "Atendente";
    return "Todos";
  })();

  const renderItems = (items: Conversation[]) =>
    items.map((conv) => (
      <ConversationItem
        key={conv.id}
        conversation={conv}
        isActive={conv.id === activeConversationId}
        onSelect={onSelect}
        client={conv.client_id ? clientsById.get(conv.client_id) ?? null : null}
      />
    ));

  return (
    // A lista é a superfície de triagem do Inbox: um pouco mais larga no
    // desktop com largura suficiente para triagem, priorizando a área central
    // de mensagens como superfície principal do atendimento.
    <div className="flex h-full w-full flex-col border-r border-border bg-background lg:w-[320px]">
      <div className="border-b border-border">
        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Atendimentos</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Priorize e encontre conversas rapidamente</p>
          </div>
          {onCreateConversation && accountRole !== "viewer" && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onCreateConversation}
              className="h-8 w-8 shrink-0"
              aria-label="Nova conversa"
              title="Nova conversa"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2 px-3 pb-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              aria-label="Buscar conversas por nome ou telefone"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Buscar conversas…"
              className="h-9 border-border/80 bg-muted/45 pl-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/50"
            />
          </div>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-9 shrink-0 gap-1.5 border-border/80 px-2.5 text-xs",
                    activeFilterCount > 0 && "border-primary/40 text-primary",
                  )}
                  aria-label={activeFilterCount > 0 ? `Filtros (${activeFilterCount} ativos)` : "Filtros"}
                />
              }
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              <span>Filtros</span>
              {activeFilterCount > 0 && (
                <span className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground" aria-hidden="true">
                  {activeFilterCount}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 gap-2 p-3">
              <div className="flex h-8 items-center justify-between">
                <span className="text-sm font-medium text-foreground">Filtros</span>
                {activeFilterCount > 0 && (
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={clearFilters}>
                    Limpar filtros
                  </Button>
                )}
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
                <FilterMenu
                  title="Atendente"
                  label={agentLabel}
                  options={[
                    { id: "me", name: "Minhas" },
                    { id: "unassigned", name: isAgent ? "Fila da equipe" : "Sem atendente" },
                    ...(isAgent ? [] : options.agents),
                  ]}
                  value={filters.atendente}
                  onChange={(v) => setFilters({ atendente: v })}
                  allLabel="Todos"
                />
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
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div
          className="flex gap-4 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label="Filtrar por canal"
        >
          {CHANNEL_TABS.map((tab) => {
            const count = unread[tab.value ?? "all"] ?? 0;
            const active = filters.canal === tab.value;
            return (
              <button
                key={tab.label}
                type="button"
                onClick={() => setFilters({ canal: tab.value, linha: null })}
                aria-pressed={active}
                aria-label={count > 0 ? `${tab.label} (${count} não lidas)` : tab.label}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-0 text-xs font-medium transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{tab.label}</span>
                {count > 0 && (
                  <span
                    className={cn(
                      "text-[10px] tabular-nums",
                      active ? "font-semibold text-primary" : "text-muted-foreground",
                    )}
                    aria-hidden="true"
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12" role="status">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
            <span className="sr-only">Carregando conversas…</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">Nenhuma conversa encontrada</p>
          </div>
        ) : grouped ? (
          <div className="flex flex-col py-1">
            <SectionHeader
              label={CONVERSATION_STATUS_LABELS_PLURAL.open}
              count={sectionTotal(openGroup.length, filters.q ? null : statusTotals.open, Boolean(nextCursor))}
              expanded={openSectionExpanded}
              onToggle={() => toggleSection("open")}
            />
            {openSectionExpanded &&
              (openGroup.length === 0 ? (
                <p className="px-4 pb-3 text-xs text-muted-foreground">Nenhuma conversa em atendimento</p>
              ) : (
                <div className="flex flex-col">{renderItems(openGroup)}</div>
              ))}
            <div className="mt-2">
              <SectionHeader
                label={CONVERSATION_STATUS_LABELS_PLURAL.pending}
                count={sectionTotal(pendingGroup.length, filters.q ? null : statusTotals.pending, Boolean(nextCursor))}
                expanded={pendingSectionExpanded}
                onToggle={() => toggleSection("pending")}
              />
              {pendingSectionExpanded &&
                (pendingGroup.length === 0 ? (
                  <p className="px-4 pb-3 text-xs text-muted-foreground">Nenhuma conversa em espera</p>
                ) : (
                  <div className="flex flex-col">{renderItems(pendingGroup)}</div>
                ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col">{renderItems(visible)}</div>
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
    </div>
  );
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
        className="flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
      >
        <span className="shrink-0 text-muted-foreground">{title}</span>
        <span className={cn("flex min-w-0 items-center gap-1", active ? "font-medium text-primary" : "text-foreground")}>
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto border-border bg-popover">
        {allLabel && (
          <DropdownMenuItem
            onClick={() => onChange(null)}
            className={cn("text-sm", value === null ? "text-primary" : "text-popover-foreground")}
          >
            {allLabel}
          </DropdownMenuItem>
        )}
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={cn("text-sm", value === opt.id ? "text-primary" : "text-popover-foreground")}
          >
            {opt.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Collapsible header for a status section ("Em Atendimento" / "Em
 *  Espera") in the default view. */
function SectionHeader({
  label,
  count,
  expanded,
  onToggle,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sticky top-0 z-10 flex w-full items-center justify-between border-b border-border/50 bg-background/95 px-3 py-2.5 text-left backdrop-blur transition-colors hover:bg-muted/35"
      aria-expanded={expanded}
    >
      <span className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
        {label}
        <span className="text-[10px] font-medium tabular-nums text-muted-foreground/80">{count}</span>
      </span>
      <ChevronDown
        aria-hidden="true"
        className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")}
      />
    </button>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Cliente da linha (selo com nome e cor). */
  client: ClientOption | null;
}

const SENTIMENT_ICONS: Record<string, { emoji: string; color: string; label: string }> = {
  positive: { emoji: "😊", color: "text-emerald-700 dark:text-emerald-400", label: "Sentimento: Positivo" },
  neutral: { emoji: "😐", color: "text-slate-700 dark:text-slate-300", label: "Sentimento: Neutro" },
  negative: { emoji: "😠", color: "text-rose-700 dark:text-rose-400", label: "Sentimento: Negativo" },
  mixed: { emoji: "🧐", color: "text-amber-700 dark:text-amber-400", label: "Sentimento: Misto" },
};

/** "Aguardando há X" para conversa sem atendente, a partir da última mensagem do cliente. */
function waitingLabel(c: Conversation): string | null {
  if (c.assigned_agent_id || c.status === "closed" || !c.last_customer_message_at) return null;
  const minutes = Math.floor((Date.now() - Date.parse(c.last_customer_message_at)) / 60_000);
  if (minutes < 5) return null;
  if (minutes < 60) return `aguardando ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `aguardando ${hours} h` : `aguardando ${Math.floor(hours / 24)} d`;
}

/** Tempo compacto desde a última mensagem: "agora", "5 min", "2 h", "3 d";
 *  a partir de 7 dias mostra a data (dd/MM/yy). */
function compactTimeAgo(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d`;
  return format(date, "dd/MM/yy", { locale: ptBR });
}

function ConversationItem({ conversation, isActive, onSelect, client }: ConversationItemProps) {
  const { accountId } = useAuth();
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Desconhecido";
  const initials = displayName.charAt(0).toUpperCase();
  const channelBadge = CHANNEL_BADGE[conversation.channel_type ?? "whatsapp"];
  const waiting = waitingLabel(conversation);
  const negative = conversation.sentiment === "negative";
  const queueSection = inboxQueueSection(conversation);
  const queueLabel = INBOX_QUEUE_LABELS[queueSection];

  const timeAgo = conversation.last_message_at ? compactTimeAgo(conversation.last_message_at) : "";
  // Tooltip com a forma longa em pt-BR ("há 3 dias").
  const timeAgoTitle = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), { addSuffix: true, locale: ptBR })
    : undefined;

  return (
    <button
      type="button"
      onClick={() => onSelect(conversation)}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 border-b border-l-2 border-b-border/45 border-l-transparent px-3 py-2.5 text-left transition-colors hover:bg-muted/40",
        isActive && "border-l-primary bg-muted/65 hover:bg-muted/65"
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground" aria-hidden="true">
        {contact?.avatar_url ? (
          <img
            // Proxy por telefone só existe para WhatsApp.
            src={
              contact.phone && accountId
                ? `/api/whatsapp/contacts/avatar?phone=${encodeURIComponent(contact.phone.replace(/^\+/, "").replace(/\s/g, ""))}&account_id=${accountId}`
                : contact.avatar_url
            }
            // Decorativo: o nome do contato já vem logo ao lado.
            alt=""
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-semibold text-foreground">{displayName}</span>
          {/* O horário vira "aguardando X" (âmbar) quando o cliente espera
              ≥ 5 min sem atendente — mesmo espaço, sem linha extra. */}
          <span
            className={cn("shrink-0 text-[11px]", waiting ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground/80")}
            title={timeAgoTitle}
          >
            {waiting ?? timeAgo}
          </span>
        </div>

        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            {/* Cliente da linha: ponto com a cor dele + nome (sem pílula colorida). */}
            {client && (
              <span className="flex max-w-[42%] shrink-0 items-center gap-1 text-[11px] text-foreground/70" title={`Cliente: ${client.name}`}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: client.color }} aria-hidden="true" />
                <span className="truncate">{client.name}</span>
                <span aria-hidden="true" className="text-muted-foreground">·</span>
              </span>
            )}
            {channelBadge && <span className="sr-only">Canal: {channelBadge.label}.</span>}
            <span className="truncate">{conversation.last_message_text || "Nenhuma mensagem ainda"}</span>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {negative && (
              <span
                className="h-2 w-2 rounded-full bg-destructive"
                role="img"
                aria-label={SENTIMENT_ICONS.negative.label}
                title={SENTIMENT_ICONS.negative.label}
              />
            )}
            {/* Não lidas OU o ponto de status — nunca os dois. */}
            {conversation.unread_count > 0 ? (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                {conversation.unread_count}
                <span className="sr-only"> não lidas</span>
              </span>
            ) : (
              null
            )}
            <span className="sr-only">Status: {queueLabel}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
