"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Brain,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Contact, Deal, ContactNote, Tag, Conversation } from "@/types";
import { format } from "date-fns";
import { toast } from "sonner";

interface ContactSidebarProps {
  contact: Contact | null;
  conversation: Conversation | null;
  onUpdateConversation?: (updates: Partial<Conversation>) => void;
  onUpdateContact?: (contact: Contact) => void;
}

export function ContactSidebar({
  contact,
  conversation,
  onUpdateConversation,
  onUpdateContact,
}: ContactSidebarProps) {
  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState("");

  useEffect(() => {
    if (contact) {
      setEditName(contact.name || contact.phone || "");
    }
  }, [contact]);

  const handleSaveName = async () => {
    if (!contact || !editName.trim()) return;
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("contacts")
        .update({ name: editName.trim() })
        .eq("id", contact.id);

      if (error) throw error;

      onUpdateContact?.({
        ...contact,
        name: editName.trim(),
      });
      setIsEditingName(false);
      toast.success("Nome do contato atualizado!");
    } catch (err: any) {
      console.error("Failed to update contact name:", err);
      toast.error("Erro ao atualizar nome do contato");
    }
  };

  const handleAnalyzeSentiment = useCallback(async () => {
    if (!conversation) return;
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/sentiment`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onUpdateConversation?.({ sentiment: data.sentiment });
      } else {
        console.error("Failed to analyze sentiment:", data.error || "Unknown error");
      }
    } catch (err) {
      console.error("Error analyzing sentiment:", err);
    } finally {
      setAnalyzing(false);
    }
  }, [conversation, onUpdateConversation]);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">Selecione uma conversa</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            {isEditingName ? (
              <div className="mt-3 flex items-center gap-1">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter") {
                      await handleSaveName();
                    } else if (e.key === "Escape") {
                      setIsEditingName(false);
                      setEditName(displayName);
                    }
                  }}
                  className="max-w-[160px] rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-primary"
                  onClick={handleSaveName}
                >
                  Salvar
                </Button>
              </div>
            ) : (
              <div 
                className="group mt-3 flex items-center justify-center gap-1.5 cursor-pointer hover:opacity-80"
                onClick={() => setIsEditingName(true)}
                title="Clique para editar o nome"
              >
                <h3 className="text-sm font-semibold text-foreground group-hover:text-primary">
                  {displayName}
                </h3>
                <svg
                  className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </div>
            )}
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Sentiment Analysis Card */}
          {conversation && (
            <div className="rounded-xl border border-border bg-card/50 p-3.5 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Brain className="h-3.5 w-3.5 text-primary" />
                  Análise de Sentimento (IA)
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground"
                  disabled={analyzing}
                  onClick={handleAnalyzeSentiment}
                  title="Reanalisar conversa com IA"
                >
                  <RefreshCw className={cn("h-3 w-3", analyzing && "animate-spin")} />
                </Button>
              </div>

              {/* Sentiment Display */}
              {(() => {
                const SENTIMENT_CONFIG: Record<
                  string,
                  { emoji: string; color: string; label: string; bg: string; border: string; desc: string }
                > = {
                  positive: {
                    emoji: "😊",
                    color: "text-emerald-500",
                    bg: "bg-emerald-500/10",
                    border: "border-emerald-500/20",
                    label: "Positivo",
                    desc: "Aproveite a boa receptividade! Mantenha o atendimento ágil e conduza para o fechamento de forma objetiva."
                  },
                  neutral: {
                    emoji: "😐",
                    color: "text-slate-400",
                    bg: "bg-slate-500/10",
                    border: "border-slate-500/20",
                    label: "Neutro",
                    desc: "Cliente direto e formal. Responda de forma clara, profissional, focada em solucionar as dúvidas sem enrolação."
                  },
                  negative: {
                    emoji: "😡",
                    color: "text-rose-500",
                    bg: "bg-rose-500/10",
                    border: "border-rose-500/20",
                    label: "Negativo",
                    desc: "Atenção: cliente insatisfeito! Aja de forma muito empática e paciente. Foque em priorizar a resolução do problema dele."
                  },
                  mixed: {
                    emoji: "😕",
                    color: "text-amber-500",
                    bg: "bg-amber-500/10",
                    border: "border-amber-500/20",
                    label: "Misto",
                    desc: "Tons variados de satisfação/insatisfação. Seja paciente para desfazer mal-entendidos e reforce os pontos positivos da proposta."
                  },
                  unknown: {
                    emoji: "❔",
                    color: "text-muted-foreground",
                    bg: "bg-muted",
                    border: "border-border",
                    label: "Não Analisado",
                    desc: "Clique no botão de recarregar acima para analisar a conversa e receber recomendações de atendimento."
                  }
                };
                const currentSentiment = conversation.sentiment || "unknown";
                const config = SENTIMENT_CONFIG[currentSentiment] || SENTIMENT_CONFIG.unknown;
                return (
                  <div className="mt-3">
                    <div className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium", config.bg, config.border, config.color)}>
                      <span className="text-lg leading-none select-none">{config.emoji}</span>
                      <span className="flex-1">{config.label}</span>
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      {config.desc}
                    </p>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              Etiquetas
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">Sem etiquetas</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              Negócios Ativos
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">Sem negócios</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{formatCurrency(deal.value, deal.currency)}</span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              Notas
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Adicionar uma nota..."
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
