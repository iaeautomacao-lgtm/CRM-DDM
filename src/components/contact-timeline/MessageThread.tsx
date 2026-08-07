"use client";

// ============================================================
// MessageThread — read-only message list rendered inside an expanded
// ConversationCard on /historico. `messages.sender_id` is never
// populated for agent-sent messages anywhere in this codebase
// (message-thread.tsx's optimistic insert and api/whatsapp/send never
// set it), so per-message sender attribution isn't possible — the
// agent bubble uses the conversation's resolved assigned-agent name
// instead of a per-message sender.
// ============================================================

import Link from "next/link";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ArrowRight, Bot } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/dashboard/skeleton";
import { cn } from "@/lib/utils";
import type { TimelineMessage } from "@/lib/contact-timeline/queries";

export function MessageThread({
  conversationId,
  loading,
  messages,
  hasMore,
  contactInitial,
  agentName,
}: {
  conversationId: string;
  loading: boolean;
  messages: TimelineMessage[];
  hasMore: boolean;
  contactInitial: string;
  agentName: string | null;
}) {
  if (loading) {
    return (
      <div className="space-y-3 p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn("flex", i % 2 === 1 && "justify-end")}>
            <Skeleton className="h-10 w-2/3 rounded-lg" />
          </div>
        ))}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <p className="p-4 text-center text-sm text-muted-foreground">
        Nenhuma mensagem encontrada para esta conversa.
      </p>
    );
  }

  return (
    <div className="space-y-3 p-4">
      {hasMore && (
        <p className="text-center text-xs text-muted-foreground">
          Mostrando as 100 primeiras mensagens —{" "}
          <Link href={`/inbox?c=${conversationId}`} className="text-primary hover:underline">
            veja o restante no Inbox
          </Link>
          .
        </p>
      )}

      {messages.map((message) => {
        const isCustomer = message.sender_type === "customer";
        const isBot = message.sender_type === "bot";
        const text = message.content_text || (message.media_url ? "[mídia]" : "");

        return (
          <div
            key={message.id}
            className={cn("flex items-end gap-2", !isCustomer && "flex-row-reverse")}
          >
            <Avatar className="size-6 shrink-0">
              <AvatarFallback
                className={cn(
                  "text-[10px] font-medium",
                  isCustomer ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
                )}
              >
                {isCustomer ? contactInitial : isBot ? <Bot className="size-3" /> : (agentName?.charAt(0).toUpperCase() ?? "A")}
              </AvatarFallback>
            </Avatar>

            <div className={cn("flex max-w-[75%] flex-col", !isCustomer && "items-end")}>
              {!isCustomer && (
                <span className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                  {isBot ? "Automação" : agentName || "Atendente"}
                </span>
              )}
              <div
                className={cn(
                  "rounded-lg px-3 py-2 text-sm break-words",
                  isCustomer ? "bg-muted text-foreground" : "bg-[#DCFCE7] text-foreground",
                )}
              >
                {text}
              </div>
              <span className="mt-0.5 text-[12px] text-muted-foreground">
                {format(new Date(message.created_at), "dd/MM/yy HH:mm", { locale: ptBR })}
              </span>
            </div>
          </div>
        );
      })}

      <div className="flex justify-end pt-1">
        <Link
          href={`/inbox?c=${conversationId}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          Ver conversa completa
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
