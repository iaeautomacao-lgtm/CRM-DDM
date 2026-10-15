"use client";

// Conversa aberta em gaveta grande dentro do Monitoramento: o supervisor
// lê o histórico e age (assumir, transferir, encerrar, mensagem interna)
// sem sair do painel. Reaproveita a conversa e o painel do contato do
// Inbox; as permissões e o escopo de equipe valem como lá (a leitura passa
// pela RLS do usuário e cada ação é barrada no servidor).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, LockKeyhole } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { apiFetch } from "@/lib/api-fetch";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/hooks/use-realtime";
import type { Contact, Conversation, ConversationStatus, Message, Tag } from "@/types";

type LoadState = "loading" | "ready" | "missing";

export function ConversationModal({
  conversationId,
  onClose,
}: {
  /** Conversa aberta. Quem usa monta o componente só enquanto há uma (key = id). */
  conversationId: string;
  onClose: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [provider, setProvider] = useState("meta");
  const [contactPanelOpen, setContactPanelOpen] = useState(false);
  const [resyncToken, setResyncToken] = useState(0);
  const open = true;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient()
        .from("conversations")
        .select("*, contact:contacts(*), outcome_tag:tags!outcome_tag_id(*)")
        .eq("id", conversationId)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        if (error) console.error("[monitoramento] abrir conversa:", error.message);
        setState("missing");
        return;
      }
      const conv = data as Conversation;
      setConversation(conv);
      setContact(conv.contact ?? null);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Provedor do WhatsApp (muda o jeito de enviar); sem resposta fica "meta".
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/whatsapp/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cancelled && cfg?.provider) setProvider(cfg.provider);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Tempo real só da conversa aberta.
  useRealtime({
    channelName: "monitor-conversation-modal",
    enabled: open,
    onMessageEvent: (event) => {
      const msg = event.new;
      if (msg.conversation_id !== conversationId) return;
      if (event.eventType === "INSERT") {
        setMessages((prev) =>
          prev.some((m) => m.id === msg.id) ? prev : [...prev.filter((m) => !m.id.startsWith("temp-")), msg],
        );
      } else if (event.eventType === "UPDATE") {
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)));
      }
    },
    onConversationEvent: (event) => {
      if (event.new.id !== conversationId) return;
      // O evento não traz o contato: mantém o que já está carregado.
      setConversation((prev) => (prev ? { ...prev, ...event.new, contact: prev.contact } : prev));
    },
  });

  const handleStatusChange = useCallback((id: string, status: ConversationStatus, outcomeTag?: Tag) => {
    setConversation((prev) =>
      prev && prev.id === id
        ? { ...prev, status, ...(outcomeTag ? { outcome_tag_id: outcomeTag.id, outcome_tag: outcomeTag } : {}) }
        : prev,
    );
  }, []);
  const handleAssignChange = useCallback((id: string, agentId: string | null) => {
    setConversation((prev) => (prev && prev.id === id ? { ...prev, assigned_agent_id: agentId ?? undefined } : prev));
  }, []);
  const handleUpdateMessage = useCallback((id: string, updates: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)));
  }, []);
  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  // Quem só acompanha não pode zerar as "não lidas" do atendente: o
  // MessageThread zera quando vê não lidas, então ele recebe a conversa
  // sempre com 0.
  const threadConversation = conversation ? { ...conversation, unread_count: 0 } : null;
  const displayName = contact?.name?.trim() || contact?.phone || "Conversa";

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-5xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-sm font-semibold">{displayName}</SheetTitle>
            <SheetDescription className="text-xs">
              Você está acompanhando esta conversa pelo Monitoramento.
            </SheetDescription>
          </div>
          <Button variant="outline" size="sm" render={<Link href={`/inbox?c=${conversationId}`} />}>
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Abrir no Conversas
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Fechar
          </Button>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {state === "loading" && (
            <div className="flex flex-1 items-center justify-center" role="status">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Carregando conversa…</span>
            </div>
          )}
          {state === "missing" && (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <LockKeyhole className="size-5 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-semibold text-foreground">Não foi possível abrir esta conversa</p>
              <p className="text-[13px] text-muted-foreground">
                Ela pode ter sido removida ou estar fora das equipes que você acompanha.
              </p>
            </div>
          )}
          {state === "ready" && (
            <>
              <div className="flex h-full min-w-0 flex-1">
                <MessageThread
                  conversation={threadConversation}
                  contact={contact}
                  messages={messages}
                  whatsappProvider={provider}
                  onMessagesLoaded={setMessages}
                  onNewMessage={handleNewMessage}
                  onUpdateMessage={handleUpdateMessage}
                  onStatusChange={handleStatusChange}
                  onAssignChange={handleAssignChange}
                  resyncToken={resyncToken}
                  onRefresh={() => setResyncToken((t) => t + 1)}
                  contactPanelOpen={contactPanelOpen}
                  onToggleContactPanel={() => setContactPanelOpen((v) => !v)}
                />
              </div>
              {contactPanelOpen && (
                <div className="absolute inset-y-0 right-0 z-30 w-[360px] max-w-full animate-ddm-drawer border-l border-border bg-card shadow-overlay xl:static xl:z-auto xl:animate-none xl:shadow-none">
                  <ContactSidebar
                    contact={contact}
                    conversation={conversation}
                    onClose={() => setContactPanelOpen(false)}
                    onUpdateConversation={(updates) =>
                      setConversation((prev) => (prev ? { ...prev, ...updates } : prev))
                    }
                    onUpdateContact={(updated) => {
                      setContact(updated);
                      setConversation((prev) =>
                        prev ? { ...prev, contact: { ...prev.contact, ...updated } } : prev,
                      );
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
