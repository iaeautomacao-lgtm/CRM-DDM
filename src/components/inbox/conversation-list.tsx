"use client";

import { apiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/hooks/use-auth";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus } from "@/types";
import { Search, ChevronDown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility â†’ visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

// "open"/"pending" used to be selectable filters; they're now the two
// fixed visual sections ("Em Atendimento" / "Em Espera") the default
// "all" view groups conversations into, so they're no longer options
// here. "closed" stays a real filter â€” closed conversations never
// appear in the grouped view, this is the only way to see them.
type InboxFilter = "all" | "unread" | "closed";

const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = [
  { label: "Todos", value: "all" },
  { label: "NÃ£o lidos", value: "unread" },
  { label: "Fechados", value: "closed" },
];

// Persisted independently per section so collapsing one doesn't touch
// the other. Same "default true, reconcile from localStorage after
// mount" pattern as inbox/page.tsx's contactPanelOpen â€” reading a
// stored `false` synchronously in the initializer would produce a
// hydration mismatch against the server-rendered `true`.
const SECTION_STORAGE_KEY = {
  open: "inbox-section-open",
  pending: "inbox-section-pending",
} as const;

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const { accountId } = useAuth();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [selectedLine, setSelectedLine] = useState<string>("all");
  const [configs, setConfigs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Section collapse state â€” defaults to expanded, reconciled from
  // localStorage after mount (see SECTION_STORAGE_KEY comment above).
  const [openSectionExpanded, setOpenSectionExpanded] = useState(true);
  const [pendingSectionExpanded, setPendingSectionExpanded] = useState(true);

  useEffect(() => {
    try {
      const storedOpen = localStorage.getItem(SECTION_STORAGE_KEY.open);
      if (storedOpen !== null) setOpenSectionExpanded(storedOpen === "true");
      const storedPending = localStorage.getItem(SECTION_STORAGE_KEY.pending);
      if (storedPending !== null) setPendingSectionExpanded(storedPending === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleOpenSection = useCallback(() => {
    setOpenSectionExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SECTION_STORAGE_KEY.open, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  const handleTogglePendingSection = useCallback(() => {
    setPendingSectionExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SECTION_STORAGE_KEY.pending, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Fetch configured lines for dropdown filter
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/api/whatsapp/config");
        const data = await res.json();
        setConfigs(data.configs || []);
      } catch (err) {
        console.error("Failed to load configs for filters:", err);
      }
    })();
  }, []);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` â€” so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value â€” the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, contact:contacts(*), outcome_tag:tags!outcome_tag_id(*)")
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties â€” log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(data ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus â€” catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Line + search + sort â€” shared by every filter mode and by both
  // grouped sections. Status/unread narrowing happens below, per mode.
  const baseFiltered = useMemo(() => {
    let result = [...conversations];

    // Sort by last_message_at descending (newest messages first)
    result.sort((a, b) => {
      const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return timeB - timeA;
    });

    if (selectedLine !== "all") {
      result = result.filter((c) => c.waha_session === selectedLine);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, selectedLine, search]);

  // "NÃ£o lidos" / "Fechados" â€” flat lists, used only when `filter`
  // picks one of them (compatibility mode, no grouping).
  const unreadFiltered = useMemo(
    () => baseFiltered.filter((c) => c.unread_count > 0),
    [baseFiltered],
  );
  const closedFiltered = useMemo(
    () => baseFiltered.filter((c) => c.status === "closed"),
    [baseFiltered],
  );

  // "Todos" (default) â€” grouped into the two fixed sections. Closed
  // conversations never appear here; "Fechados" above is the only way
  // to see them.
  const openGroup = useMemo(
    () => baseFiltered.filter((c) => c.status === "open"),
    [baseFiltered],
  );
  const pendingGroup = useMemo(
    () => baseFiltered.filter((c) => c.status === "pending"),
    [baseFiltered],
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Buscar conversas..."
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                Status: {activeFilter?.label ?? "All"}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {configs.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted truncate max-w-[150px]">
                  Linha: {selectedLine === "all" ? "Todas" : (configs.find(c => c.waha_session === selectedLine)?.phone_info?.display_phone_number || selectedLine)}
                  <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedLine("all")}
                  className={cn(
                    "text-sm",
                    selectedLine === "all" ? "text-primary" : "text-popover-foreground"
                  )}
                >
                  Todas as Linhas
                </DropdownMenuItem>
                {configs.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onClick={() => setSelectedLine(c.waha_session)}
                    className={cn(
                      "text-sm",
                      selectedLine === c.waha_session ? "text-primary" : "text-popover-foreground"
                    )}
                  >
                    {c.phone_info?.display_phone_number || c.waha_session}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space â€” the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filter === "unread" || filter === "closed" ? (
          // Compatibility mode â€” flat list, no sections.
          (() => {
            const flat = filter === "unread" ? unreadFiltered : closedFiltered;
            return flat.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <p className="text-sm text-muted-foreground">Nenhuma conversa encontrada</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {flat.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={conv.id === activeConversationId}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            );
          })()
        ) : (
          // "Todos" â€” grouped into the two fixed sections.
          <div className="flex flex-col py-1">
            <div>
              <SectionHeader
                label="Em Atendimento"
                count={openGroup.length}
                expanded={openSectionExpanded}
                onToggle={handleToggleOpenSection}
              />
              {openSectionExpanded && (
                <div className="flex flex-col">
                  {openGroup.length === 0 ? (
                    <p className="px-4 pb-3 text-xs text-muted-foreground">
                      Nenhuma conversa em atendimento
                    </p>
                  ) : (
                    openGroup.map((conv) => (
                      <ConversationItem
                        key={conv.id}
                        conversation={conv}
                        isActive={conv.id === activeConversationId}
                        onSelect={handleSelect}
                      />
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="mt-2">
              <SectionHeader
                label="Em Espera"
                count={pendingGroup.length}
                expanded={pendingSectionExpanded}
                onToggle={handleTogglePendingSection}
              />
              {pendingSectionExpanded && (
                <div className="flex flex-col">
                  {pendingGroup.length === 0 ? (
                    <p className="px-4 pb-3 text-xs text-muted-foreground">
                      Nenhuma conversa em espera
                    </p>
                  ) : (
                    pendingGroup.map((conv) => (
                      <ConversationItem
                        key={conv.id}
                        conversation={conv}
                        isActive={conv.id === activeConversationId}
                        onSelect={handleSelect}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/** Collapsible header for a status section ("Em Atendimento" / "Em
 *  Espera") in the default "Todos" view. Chevron rotates in place
 *  rather than swapping icons â€” no separator, sections are told
 *  apart by spacing alone (`mt-2` between them in the parent). */
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
        className={cn(
          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
          !expanded && "-rotate-90",
        )}
      />
    </button>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
}

const SENTIMENT_ICONS: Record<string, { emoji: string; color: string; label: string }> = {
  positive: { emoji: "ðŸ˜Š", color: "text-emerald-500", label: "Sentimento: Positivo" },
  neutral: { emoji: "ðŸ˜", color: "text-slate-400", label: "Sentimento: Neutro" },
  negative: { emoji: "ðŸ˜ ", color: "text-rose-500", label: "Sentimento: Negativo" },
  mixed: { emoji: "ðŸ§", color: "text-amber-500", label: "Sentimento: Misto" },
};

function ConversationItem({
  conversation,
  isActive,
  onSelect,
}: ConversationItemProps) {
  const { accountId } = useAuth();
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Desconhecido";
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
        .replace("about", "")
        .replace("less than a minute", "agora")
        .replace("minute", "min")
        .replace("hours", "h")
        .replace("hour", "h")
        .replace("days", "d")
        .replace("day", "d")
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url && accountId ? `/api/whatsapp/contacts/avatar?phone=${encodeURIComponent(contact.phone)}&account_id=${accountId}` : contact.avatar_url ?? ""}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>

        {/* Line badge */}
        {(conversation as any).waha_session && (
          <div className="mt-0.5">
            <span className="inline-block text-[9px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20 leading-none select-none">
              {(conversation as any).waha_session}
            </span>
          </div>
        )}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || "Nenhuma mensagem ainda"}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {/* Sentiment Emoji */}
            {conversation.sentiment && conversation.sentiment !== "unknown" && (
              <span
                className={cn("text-xs leading-none select-none", SENTIMENT_ICONS[conversation.sentiment]?.color)}
                title={SENTIMENT_ICONS[conversation.sentiment]?.label}
              >
                {SENTIMENT_ICONS[conversation.sentiment]?.emoji}
              </span>
            )}

            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}


