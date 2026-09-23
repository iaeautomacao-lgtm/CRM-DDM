"use client";

// InternalChatDialog — 1:1 staff chat (operador <-> supervisor),
// wacrm.internal_messages (migration 109). Two steps: pick a contact,
// then a plain thread for that pair. No conversation/thread row — a
// "thread" is just every internal_messages row where the two users
// are sender+recipient of each other, queried directly (symmetric —
// doesn't care which side of the pair is "me").
//
// `mode` picks who step 1 offers as contacts:
//   'operator'   (agent)          — supervisors reachable from my team
//                                    (team_members-derived, falling back
//                                    to account-wide admins/owners for
//                                    an agent with no team)
//   'supervisor' (admin/owner)    — operators who have actually messaged
//                                    me (DISTINCT sender_id from rows
//                                    where I'm recipient), since a
//                                    supervisor has no fixed "my team"
//                                    the way an operator does

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Send } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { InternalMessage } from "@/types";

type InternalChatMode = "operator" | "supervisor";

interface InternalChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: InternalChatMode;
}

interface ChatContact {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

function displayNameOf(p: ChatContact): string {
  return p.full_name || p.email || "Sem nome";
}

export function InternalChatDialog({
  open,
  onOpenChange,
  mode = "operator",
}: InternalChatDialogProps) {
  const { user, accountId } = useAuth();
  const myUserId = user?.id;

  const [step, setStep] = useState<"list" | "thread">("list");
  const [contacts, setContacts] = useState<ChatContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ChatContact | null>(null);
  const [messages, setMessages] = useState<InternalMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollBottomRef = useRef<HTMLDivElement>(null);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setStep("list");
      setSelectedContact(null);
      setMessages([]);
      setDraft("");
    }
    onOpenChange(next);
  }

  // Step 1 — contact list.
  //
  // 'supervisor': DISTINCT sender_id from internal_messages where I'm
  // recipient — PostgREST has no SELECT DISTINCT, so this fetches
  // every matching row and dedupes client-side via Set, same as the
  // 'operator' branch below already does for team_members rows.
  //
  // 'operator': team_members.user_id has no FK to profiles (confirmed
  // dead end in flows/engine.ts — PGRST200 on an embedded
  // profiles!inner there), so this is two queries + a JS join, same
  // shape already used across the codebase for this exact relation.
  const fetchContacts = useCallback(async () => {
    if (!myUserId || !accountId) return;
    setContactsLoading(true);
    try {
      const supabase = createClient();

      if (mode === "supervisor") {
        const { data: sent, error } = await supabase
          .from("internal_messages")
          .select("sender_id")
          .eq("recipient_id", myUserId);
        if (error) throw error;

        const senderIds = Array.from(
          new Set((sent ?? []).map((r) => r.sender_id as string)),
        );
        if (senderIds.length === 0) {
          setContacts([]);
          return;
        }

        const { data, error: profilesError } = await supabase
          .from("profiles")
          .select("user_id, full_name, email, avatar_url")
          .in("user_id", senderIds);
        if (profilesError) throw profilesError;
        setContacts((data ?? []) as ChatContact[]);
        return;
      }

      const { data: myTeams, error: myTeamsError } = await supabase
        .from("team_members")
        .select("team_id")
        .eq("user_id", myUserId);
      if (myTeamsError) throw myTeamsError;

      const teamIds = (myTeams ?? []).map((t) => t.team_id as string);

      if (teamIds.length === 0) {
        const { data, error } = await supabase
          .from("profiles")
          .select("user_id, full_name, email, avatar_url")
          .eq("account_id", accountId)
          .in("account_role", ["admin", "owner"])
          .neq("user_id", myUserId);
        if (error) throw error;
        setContacts((data ?? []) as ChatContact[]);
        return;
      }

      const { data: teammates, error: teammatesError } = await supabase
        .from("team_members")
        .select("user_id")
        .in("team_id", teamIds);
      if (teammatesError) throw teammatesError;

      const candidateIds = Array.from(
        new Set((teammates ?? []).map((t) => t.user_id as string)),
      ).filter((id) => id !== myUserId);
      if (candidateIds.length === 0) {
        setContacts([]);
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, email, avatar_url")
        .in("user_id", candidateIds)
        .eq("account_role", "admin");
      if (error) throw error;
      setContacts((data ?? []) as ChatContact[]);
    } catch (err) {
      console.error("[InternalChatDialog] failed to load contacts:", err);
      toast.error(
        mode === "supervisor" ? "Falha ao carregar operadores" : "Falha ao carregar supervisores",
      );
      setContacts([]);
    } finally {
      setContactsLoading(false);
    }
  }, [myUserId, accountId, mode]);

  useEffect(() => {
    if (!open) return;
    setStep("list");
    setSelectedContact(null);
    setMessages([]);
    fetchContacts();
  }, [open, fetchContacts]);

  // Step 2 — thread for the selected pair, plus marking any unread
  // messages from that contact as read now that they're visible. The
  // query and the mark-as-read are already symmetric in sender/
  // recipient terms, so this needs no mode branching at all.
  useEffect(() => {
    if (!open || step !== "thread" || !selectedContact || !myUserId || !accountId) return;
    let cancelled = false;
    const supabase = createClient();

    (async () => {
      setMessagesLoading(true);
      try {
        const { data, error } = await supabase
          .from("internal_messages")
          .select("*")
          .eq("account_id", accountId)
          .or(
            `and(sender_id.eq.${myUserId},recipient_id.eq.${selectedContact.user_id}),and(sender_id.eq.${selectedContact.user_id},recipient_id.eq.${myUserId})`,
          )
          .order("created_at", { ascending: true });
        if (cancelled) return;
        if (error) throw error;
        setMessages((data ?? []) as InternalMessage[]);

        const { error: readError } = await supabase
          .from("internal_messages")
          .update({ read_at: new Date().toISOString() })
          .eq("recipient_id", myUserId)
          .eq("sender_id", selectedContact.user_id)
          .is("read_at", null);
        if (readError) {
          console.error("[InternalChatDialog] failed to mark messages read:", readError);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[InternalChatDialog] failed to load thread:", err);
          toast.error("Falha ao carregar conversa");
        }
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, step, selectedContact, myUserId, accountId]);

  // Live updates for the open thread — two listeners (sender_id /
  // recipient_id) since a single postgres_changes filter can't
  // express OR; RLS (internal_messages_select) is the real boundary,
  // this is just routing. Re-subscribes per selected contact rather
  // than juggling a ref, same trade-off contact-sidebar's effects
  // make elsewhere in this codebase.
  useEffect(() => {
    if (!open || step !== "thread" || !selectedContact || !myUserId || !accountId) return;
    const supabase = createClient();
    const contactId = selectedContact.user_id;

    const handleInsert = (payload: { new: InternalMessage }) => {
      const row = payload.new;
      const belongsToThread =
        (row.sender_id === myUserId && row.recipient_id === contactId) ||
        (row.sender_id === contactId && row.recipient_id === myUserId);
      if (!belongsToThread) return;

      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));

      if (row.sender_id === contactId && row.recipient_id === myUserId) {
        supabase
          .from("internal_messages")
          .update({ read_at: new Date().toISOString() })
          .eq("id", row.id)
          .then(({ error }) => {
            if (error) {
              console.error("[InternalChatDialog] failed to mark message read:", error);
            }
          });
      }
    };

    const channel: RealtimeChannel = supabase
      .channel(`internal-chat:${accountId}:${myUserId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "wacrm",
          table: "internal_messages",
          filter: `sender_id=eq.${myUserId}`,
        },
        handleInsert,
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "wacrm",
          table: "internal_messages",
          filter: `recipient_id=eq.${myUserId}`,
        },
        handleInsert,
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [open, step, selectedContact, myUserId, accountId]);

  useEffect(() => {
    scrollBottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function openThread(contact: ChatContact) {
    setSelectedContact(contact);
    setMessages([]);
    setStep("thread");
  }

  function backToList() {
    setStep("list");
    setSelectedContact(null);
    setMessages([]);
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content || !selectedContact || !myUserId || !accountId || sending) return;
    setSending(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("internal_messages")
        .insert({
          account_id: accountId,
          sender_id: myUserId,
          recipient_id: selectedContact.user_id,
          content,
        })
        .select()
        .single();
      if (error) throw error;
      setMessages((prev) =>
        prev.some((m) => m.id === data.id) ? prev : [...prev, data as InternalMessage],
      );
      setDraft("");
    } catch (err) {
      console.error("[InternalChatDialog] failed to send message:", err);
      toast.error("Falha ao enviar mensagem");
    } finally {
      setSending(false);
    }
  }

  const listTitle = mode === "supervisor" ? "Mensagens internas" : "Conversar com supervisor";
  const emptyListMessage =
    mode === "supervisor" ? "Nenhuma mensagem recebida ainda." : "Nenhum supervisor disponível.";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[32rem] flex-col border-border bg-background p-0 sm:max-w-sm">
        {step === "list" ? (
          <>
            <DialogHeader className="border-b border-border px-4 pb-3 pt-4">
              <DialogTitle className="text-foreground">{listTitle}</DialogTitle>
            </DialogHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-0.5 p-2">
                {contactsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : contacts.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {emptyListMessage}
                  </p>
                ) : (
                  contacts.map((c) => {
                    const name = displayNameOf(c);
                    return (
                      <button
                        key={c.user_id}
                        type="button"
                        onClick={() => openThread(c)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
                      >
                        <Avatar className="size-8 shrink-0">
                          {c.avatar_url ? <AvatarImage src={c.avatar_url} alt={name} /> : null}
                          <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                            {name.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {name}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          selectedContact && (
            <>
              <DialogHeader className="flex-row items-center gap-2 space-y-0 border-b border-border px-2 pb-3 pt-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={backToList}
                  aria-label="Voltar"
                  className="shrink-0 text-muted-foreground"
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <Avatar className="size-7 shrink-0">
                  {selectedContact.avatar_url ? (
                    <AvatarImage
                      src={selectedContact.avatar_url}
                      alt={displayNameOf(selectedContact)}
                    />
                  ) : null}
                  <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                    {displayNameOf(selectedContact).charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <DialogTitle className="min-w-0 flex-1 truncate text-left text-sm text-foreground">
                  {displayNameOf(selectedContact)}
                </DialogTitle>
              </DialogHeader>

              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-2 p-3">
                  {messagesLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : messages.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      Nenhuma mensagem ainda. Diga oi!
                    </p>
                  ) : (
                    messages.map((m) => {
                      const mine = m.sender_id === myUserId;
                      return (
                        <div
                          key={m.id}
                          className={`flex ${mine ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                              mine
                                ? "bg-primary text-primary-foreground"
                                : "border border-border bg-muted text-foreground"
                            }`}
                          >
                            <p className="whitespace-pre-wrap">{m.content}</p>
                            <p
                              className={`mt-1 text-[10px] ${
                                mine ? "text-primary-foreground/70" : "text-muted-foreground"
                              }`}
                            >
                              {new Date(m.created_at).toLocaleTimeString("pt-BR", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={scrollBottomRef} />
                </div>
              </ScrollArea>

              <div className="flex items-center gap-2 border-t border-border p-3">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Escreva uma mensagem..."
                  disabled={sending}
                  className="flex-1"
                />
                <Button
                  type="button"
                  size="icon"
                  onClick={handleSend}
                  disabled={sending || !draft.trim()}
                  aria-label="Enviar mensagem"
                >
                  {sending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                </Button>
              </div>
            </>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
