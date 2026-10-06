"use client";

import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus } from "@/types";
import { Search, ChevronDown, Plus, Loader2 } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Input } from "@/components/ui/input";
import { CONVERSATION_STATUS_LABELS, CONVERSATION_STATUS_LABELS_PLURAL } from "./status-labels";
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

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

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
    } finally {
      setLoadingMore(false);
    }
  }, [filtersKey, nextCursor, loadingMore]);

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
  const openGroup = useMemo(() => visible.filter((c) => c.status === "open"), [visible]);
  const pendingGroup = useMemo(() => visible.filter((c) => c.status === "pending"), [visible]);

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
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              aria-label="Buscar conversas por nome ou telefone"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Buscar por nome ou telefone..."
              className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
            />
          </div>
          {onCreateConversation && accountRole !== "viewer" && (
            <Button type="button" variant="outline" size="sm" onClick={onCreateConversation} className="h-9 shrink-0 lg:h-7" aria-label="Nova conversa">
              <Plus className="size-3.5" aria-hidden="true" />
              Nova
            </Button>
          )}
        </div>

        {/* Abas de canal com número de conversas não lidas. */}
        <div className="-mx-1 flex gap-1 overflow-x-auto pb-0.5" role="group" aria-label="Filtrar por canal">
          {CHANNEL_TABS.map((tab) => {
            const count = unread[tab.value ?? "all"] ?? 0;
            const active = filters.canal === tab.value;
            return (
              <button
                key={tab.label}
                type="button"
                onClick={() => setFilters({ canal: tab.value, linha: null })}
                aria-pressed={active}
                className={cn(
                  "flex min-h-8 shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors lg:min-h-0",
                  active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
                {count > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1 text-[9px] font-bold",
                      active ? "bg-primary-foreground/20" : "bg-primary/15 text-primary"
                    )}
                  >
                    {count > 99 ? "99+" : count}
                    <span className="sr-only"> não lidas</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-1">
          <FilterMenu
            label={`Status: ${STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ?? ""}`}
            options={STATUS_OPTIONS.map((o) => ({ id: o.value, name: o.label }))}
            value={filters.status}
            onChange={(v) => setFilters({ status: (v ?? "active") as InboxStatus })}
          />
          <FilterMenu
            label={`Atendente: ${agentLabel}`}
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
              label={`Linha: ${linesForTab.find((l) => l.id === filters.linha)?.name ?? "Todas"}`}
              options={linesForTab.map((l) => ({ id: l.id, name: l.name }))}
              value={filters.linha}
              onChange={(v) => setFilters({ linha: v })}
              allLabel="Todas as linhas"
            />
          )}
          {!isAgent && options.teams.length > 0 && (
            <FilterMenu
              label={`Equipe: ${options.teams.find((t) => t.id === filters.equipe)?.name ?? "Todas"}`}
              options={options.teams}
              value={filters.equipe}
              onChange={(v) => setFilters({ equipe: v })}
              allLabel="Todas as equipes"
            />
          )}
          {options.clients.length > 0 && (
            <FilterMenu
              label={`Cliente: ${options.clients.find((c) => c.id === filters.cliente)?.name ?? "Todos"}`}
              options={options.clients}
              value={filters.cliente}
              onChange={(v) => setFilters({ cliente: v })}
              allLabel="Todos os clientes"
            />
          )}
          {options.campaigns.length > 0 && (
            <FilterMenu
              label={`Campanha: ${options.campaigns.find((c) => c.id === filters.campanha)?.name ?? "Todas"}`}
              options={options.campaigns}
              value={filters.campanha}
              onChange={(v) => setFilters({ campanha: v })}
              allLabel="Todas as campanhas"
            />
          )}
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
              count={openGroup.length}
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
                count={pendingGroup.length}
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
          <div className="p-3">
            <Button variant="ghost" size="sm" className="w-full text-xs" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Carregar mais"}
            </Button>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/** Menu de filtro com opção "todos" (quando `allLabel` é passado). */
function FilterMenu({
  label,
  options,
  value,
  onChange,
  allLabel,
}: {
  label: string;
  options: NamedOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  allLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-9 max-w-[170px] items-center justify-center gap-1 truncate rounded-md px-2 text-xs hover:bg-muted lg:h-7",
          value && allLabel ? "text-primary" : "text-muted-foreground hover:text-foreground"
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
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
      className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-muted/40"
      aria-expanded={expanded}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          ({count})
        </span>
      </span>
      <ChevronDown
        aria-hidden="true"
        className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")}
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
  positive: { emoji: "😊", color: "text-emerald-500", label: "Sentimento: Positivo" },
  neutral: { emoji: "😐", color: "text-slate-400", label: "Sentimento: Neutro" },
  negative: { emoji: "😠", color: "text-rose-500", label: "Sentimento: Negativo" },
  mixed: { emoji: "🧐", color: "text-amber-500", label: "Sentimento: Misto" },
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
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground" aria-hidden="true">
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
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground" title={timeAgoTitle}>
            {timeAgo}
          </span>
        </div>

        {/* Canal (fora do WhatsApp), cliente da linha e sessão WAHA. */}
        {(channelBadge || client || conversation.waha_session) && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {channelBadge && (
              <span
                className={cn(
                  "inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold leading-none select-none",
                  channelBadge.className
                )}
              >
                {channelBadge.label}
              </span>
            )}
            {client && (
              <span
                className="inline-block rounded border px-1.5 py-0.5 text-[9px] font-semibold leading-none select-none"
                style={{ color: client.color, backgroundColor: `${client.color}1a`, borderColor: `${client.color}40` }}
              >
                {client.name}
              </span>
            )}
            {conversation.waha_session && (
              <span className="inline-block rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-primary select-none">
                {conversation.waha_session}
              </span>
            )}
          </div>
        )}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || "Nenhuma mensagem ainda"}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {conversation.sentiment && conversation.sentiment !== "unknown" && (
              <span
                className={cn("text-xs leading-none select-none", SENTIMENT_ICONS[conversation.sentiment]?.color)}
                title={SENTIMENT_ICONS[conversation.sentiment]?.label}
                role="img"
                aria-label={SENTIMENT_ICONS[conversation.sentiment]?.label}
              >
                {SENTIMENT_ICONS[conversation.sentiment]?.emoji}
              </span>
            )}
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
                <span className="sr-only"> não lidas</span>
              </span>
            )}
            {/* Status só por cor no visual; o texto vai para leitor de tela. */}
            <span className={cn("h-2 w-2 rounded-full", STATUS_COLORS[conversation.status])} title={CONVERSATION_STATUS_LABELS[conversation.status]} aria-hidden="true" />
            <span className="sr-only">Status: {CONVERSATION_STATUS_LABELS[conversation.status]}</span>
          </div>
        </div>
        {waiting && <p className="mt-0.5 text-[10px] font-medium text-amber-600">{waiting}</p>}
      </div>
    </button>
  );
}
