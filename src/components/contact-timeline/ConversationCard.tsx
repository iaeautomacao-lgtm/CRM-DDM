"use client";

// ============================================================
// ConversationCard — one timeline entry on /historico. Expands inline
// to show its messages (lazy-fetched on first expand, cached after).
// ============================================================

import { useState } from "react";
import { differenceInDays, format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Calendar, ChevronDown, ChevronRight, MessageCircle, UserRound, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { TimelineConversation, TimelineMessage } from "@/lib/contact-timeline/queries";
import { loadConversationMessages } from "@/lib/contact-timeline/queries";
import { MessageThread } from "./MessageThread";

const STATUS_BADGE: Record<
  TimelineConversation["status"],
  { label: string; className: string }
> = {
  open: { label: "Em andamento", className: "bg-[#DBEAFE] text-[#1E40AF]" },
  pending: { label: "Pendente", className: "bg-[#FEF3C7] text-[#92400E]" },
  closed: { label: "Encerrado", className: "bg-[#F3F4F6] text-[#374151]" },
};

export function ConversationCard({
  conversation,
  agentName,
  teamName,
  contactInitial,
}: {
  conversation: TimelineConversation;
  agentName: string | null;
  teamName: string | null;
  contactInitial: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messages, setMessages] = useState<TimelineMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const createdAt = new Date(conversation.created_at);
  const closedAt = conversation.status === "closed" ? new Date(conversation.updated_at) : new Date();
  const durationDays = differenceInDays(closedAt, createdAt);
  const durationLabel =
    durationDays < 1
      ? "< 1 dia de duração"
      : `${durationDays} ${durationDays === 1 ? "dia" : "dias"} de duração`;

  const channelLabel = conversation.waha_session || "WhatsApp";
  const status = STATUS_BADGE[conversation.status];

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && messages === null) {
      setLoadingMessages(true);
      try {
        const db = createClient();
        const { messages: rows, hasMore: more } = await loadConversationMessages(
          db,
          conversation.id,
        );
        setMessages(rows);
        setHasMore(more);
      } catch (err) {
        console.error("[historico] failed to load messages:", err);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }
    }
  }

  return (
    <div className="relative pl-8">
      <span className="absolute top-1 left-0 flex size-6 items-center justify-center rounded-full border border-border bg-card">
        <MessageCircle className="size-3.5 text-[#25D366]" />
      </span>

      <div
        role="button"
        tabIndex={0}
        onClick={toggleExpand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggleExpand();
        }}
        className="cursor-pointer rounded-xl border border-border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.1)] transition-colors hover:bg-[#FFF7F4]"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-medium text-foreground">
              Chat • {channelLabel} — {durationLabel}{" "}
              <span className="text-muted-foreground">
                · há {formatDistanceToNow(createdAt, { locale: ptBR })}
              </span>
            </p>

            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Calendar className="size-3.5" />
                Iniciado em {format(createdAt, "dd/MM/yy HH:mm")}
              </span>
              <span className="inline-flex items-center gap-1">
                <UserRound className="size-3.5" />
                {agentName || "Sem agente"}
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", status.className)}>
                {status.label}
                {conversation.outcome_tag ? ` · ${conversation.outcome_tag.name}` : ""}
              </span>
            </div>

            {teamName && (
              <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="size-3.5" />
                {teamName}
              </p>
            )}
          </div>

          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-1 overflow-hidden rounded-xl border border-border bg-background">
          <MessageThread
            conversationId={conversation.id}
            loading={loadingMessages}
            messages={messages ?? []}
            hasMore={hasMore}
            contactInitial={contactInitial}
            agentName={agentName}
          />
        </div>
      )}
    </div>
  );
}
