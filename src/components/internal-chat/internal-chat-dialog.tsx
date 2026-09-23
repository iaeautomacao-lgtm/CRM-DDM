"use client";

// InternalChatDialog — 1:1 staff chat (operador <-> supervisor),
// wacrm.internal_messages (migration 109). Two steps: pick a
// supervisor (team_members-derived, falling back to account-wide
// admins/owners for an agent with no team), then a plain thread for
// that pair. No conversation/thread row — a "thread" is just every
// internal_messages row where the two users are sender+recipient of
// each other, queried directly.

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

interface InternalChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SupervisorProfile {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

function displayNameOf(p: SupervisorProfile): string {
  return p.full_name || p.email || "Sem nome";
}

export function InternalChatDialog({ open, onOpenChange }: InternalChatDialogProps) {
  const { user, accountId } = useAuth();
  const myUserId = user?.id;

  const [step, setStep] = useState<"list" | "thread">("list");
  const [supervisors, setSupervisors] = useState<SupervisorProfile[]>([]);
  const [supervisorsLoading, setSupervisorsLoading] = useState(false);
  const [selectedSupervisor, setSelectedSupervisor] = useState<SupervisorProfile | null>(null);
  const [messages, setMessages] = useState<InternalMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollBottomRef = useRef<HTMLDivElement>(null);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setStep("list");
      setSelectedSupervisor(null);
      setMessages([]);
      setDraft("");
    }
    onOpenChange(next);
  }

  // Step 1 — supervisor list. Two team_members.user_id has no FK to
  // profiles (confirmed dead end in flows/engine.ts — PGRST200 on an
  // embedded profiles!inner there), so this is two queries + a JS
  // join, same shape already used across the codebase for this exact
  // relation.
  const fetchSupervisors = useCallback(async () => {
    if (!myUserId || !accountId) return;
    setSupervisorsLoading(true);
    try {
      const supabase = createClient();
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
        setSupervisors((data ?? []) as SupervisorProfile[]);
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
        setSupervisors([]);
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, email, avatar_url")
        .in("user_id", candidateIds)
        .eq("account_role", "admin");
      if (error) throw error;
      setSupervisors((data ?? []) as SupervisorProfile[]);
    } catch (err) {
      console.error("[InternalChatDialog] failed to load supervisors:", err);
      toast.error("Falha ao carregar supervisores");
      setSupervisors([]);
    } finally {
      setSupervisorsLoading(false);
    }
  }, [myUserId, accountId]);

  useEffect(() => {
    if (!open) return;
    setStep("list");
    setSelectedSupervisor(null);
    setMessages([]);
    fetchSupervisors();
  }, [open, fetchSupervisors]);

  // Step 2 — thread for the selected pair, plus marking any unread
  // messages from that supervisor as read now that they're visible.
  useEffect(() => {
    if (!open || step !== "thread" || !selectedSupervisor || !myUserId || !accountId) return;
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
            `and(sender_id.eq.${myUserId},recipient_id.eq.${selectedSupervisor.user_id}),and(sender_id.eq.${selectedSupervisor.user_id},recipient_id.eq.${myUserId})`,
          )
          .order("created_at", { ascending: true });
        if (cancelled) return;
        if (error) throw error;
        setMessages((data ?? []) as InternalMessage[]);

        const { error: readError } = await supabase
          .from("internal_messages")
          .update({ read_at: new Date().toISOString() })
          .eq("recipient_id", myUserId)
          .eq("sender_id", selectedSupervisor.user_id)
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
  }, [open, step, selectedSupervisor, myUserId, accountId]);

  // Live updates for the open thread — two listeners (sender_id /
  // recipient_id) since a single postgres_changes filter can't
  // express OR; RLS (internal_messages_select) is the real boundary,
  // this is just routing. Re-subscribes per selected supervisor
  // rather than juggling a ref, same trade-off contact-sidebar's
  // effects make elsewhere in this codebase.
  useEffect(() => {
    if (!open || step !== "thread" || !selectedSupervisor || !myUserId || !accountId) return;
    const supabase = createClient();
    const supervisorId = selectedSupervisor.user_id;

    const handleInsert = (payload: { new: InternalMessage }) => {
      const row = payload.new;
      const belongsToThread =
        (row.sender_id === myUserId && row.recipient_id === supervisorId) ||
        (row.sender_id === supervisorId && row.recipient_id === myUserId);
      if (!belongsToThread) return;

      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));

      if (row.sender_id === supervisorId && row.recipient_id === myUserId) {
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
  }, [open, step, selectedSupervisor, myUserId, accountId]);

  useEffect(() => {
    scrollBottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function openThread(supervisor: SupervisorProfile) {
    setSelectedSupervisor(supervisor);
    setMessages([]);
    setStep("thread");
  }

  function backToList() {
    setStep("list");
    setSelectedSupervisor(null);
    setMessages([]);
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content || !selectedSupervisor || !myUserId || !accountId || sending) return;
    setSending(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("internal_messages")
        .insert({
          account_id: accountId,
          sender_id: myUserId,
          recipient_id: selectedSupervisor.user_id,
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[32rem] flex-col border-border bg-background p-0 sm:max-w-sm">
        {step === "list" ? (
          <>
            <DialogHeader className="border-b border-border px-4 pb-3 pt-4">
              <DialogTitle className="text-foreground">Conversar com supervisor</DialogTitle>
            </DialogHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-0.5 p-2">
                {supervisorsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : supervisors.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    Nenhum supervisor disponível.
                  </p>
                ) : (
                  supervisors.map((s) => {
                    const name = displayNameOf(s);
                    return (
                      <button
                        key={s.user_id}
                        type="button"
                        onClick={() => openThread(s)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
                      >
                        <Avatar className="size-8 shrink-0">
                          {s.avatar_url ? <AvatarImage src={s.avatar_url} alt={name} /> : null}
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
          selectedSupervisor && (
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
                  {selectedSupervisor.avatar_url ? (
                    <AvatarImage
                      src={selectedSupervisor.avatar_url}
                      alt={displayNameOf(selectedSupervisor)}
                    />
                  ) : null}
                  <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                    {displayNameOf(selectedSupervisor).charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <DialogTitle className="min-w-0 flex-1 truncate text-left text-sm text-foreground">
                  {displayNameOf(selectedSupervisor)}
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
