"use client";

import { apiFetch } from "@/lib/api-fetch";
import { ConversationOriginCard } from "@/components/inbox/conversation-origin";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  StickyNote,
  Plus,
  Brain,
  RefreshCw,
  History,
  Loader2,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Contact, ContactNote, Tag, Conversation } from "@/types";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  loadContactConversations,
  type TimelineConversation,
} from "@/lib/contact-timeline/queries";
import { ConversationCard } from "@/components/contact-timeline/ConversationCard";
import { ConversationFlowCard } from "@/components/inbox/conversation-flow-card";
import { ContactChannelsCard } from "@/components/inbox/contact-channels-card";
import { useCan } from "@/hooks/use-can";
import { canAccessRoute } from "@/lib/role-utils";

// One more than the display cap — same "fetch cap+1 to detect more
// without a second COUNT query" shape loadConversationMessages uses.
// Not perfectly precise once the current conversation happens to be
// among the fetched rows (it gets filtered out below, so "more than
// 5 remain" can under-count by one in that specific case) — an
// acceptable trade-off for a sidebar convenience link, not worth a
// second round trip to get exactly right.
const HISTORY_FETCH_LIMIT = 6;
const HISTORY_DISPLAY_LIMIT = 5;

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
  const { accountId, accountRole } = useAuth();
  // Card "Fluxo" só para owner/admin (o agente não vê o fluxo da conversa).
  // O link para o editor depende de quem pode abrir /flows (ROUTE_ALLOWLIST).
  const canViewFlows = useCan("view-conversation-flows");
  const canOpenFlowEditor = !!accountRole && canAccessRoute(accountRole, "/flows");
  const [copied, setCopied] = useState(false);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const { sections, toggleSection } = useSidebarSections();
  const [history, setHistory] = useState<TimelineConversation[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

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

  // Conversa aberta agora — a análise leva alguns segundos e o atendente
  // pode trocar de conversa no meio: o resultado só vale para a conversa
  // que pediu (a outra recebe o seu pelo realtime).
  const currentConversationIdRef = useRef<string | null>(null);
  currentConversationIdRef.current = conversation?.id ?? null;

  const handleAnalyzeSentiment = useCallback(async () => {
    if (!conversation) return;
    const requestedId = conversation.id;
    setAnalyzing(true);
    try {
      const res = await apiFetch(`/api/conversations/${requestedId}/sentiment`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (currentConversationIdRef.current === requestedId) {
          onUpdateConversation?.({ sentiment: data.sentiment });
        }
      } else {
        console.error("Failed to analyze sentiment:", data.error || "Unknown error");
      }
    } catch (err) {
      console.error("Error analyzing sentiment:", err);
    } finally {
      setAnalyzing(false);
    }
  }, [conversation, onUpdateConversation]);

  // Conversa ainda sem análise (antiga, ou de antes da análise rodar em
  // todos os canais): analisa sozinha ao abrir, uma vez por conversa
  // nesta tela — sem precisar clicar em atualizar.
  const autoAnalyzedRef = useRef<Set<string>>(new Set());
  const analyzeRef = useRef(handleAnalyzeSentiment);
  analyzeRef.current = handleAnalyzeSentiment;
  const conversationIdForAuto = conversation?.id;
  const sentimentForAuto = conversation?.sentiment;
  // Só quando o cliente já escreveu (last_customer_message_at, trigger da
  // 128) — conversa só de campanha/bot não tem o que analisar.
  const hasCustomerMessageForAuto = Boolean(conversation?.last_customer_message_at);
  const canAutoAnalyze = !!accountRole && accountRole !== "viewer";
  useEffect(() => {
    if (!canAutoAnalyze || !conversationIdForAuto || !hasCustomerMessageForAuto) return;
    if (sentimentForAuto && sentimentForAuto !== "unknown") return;
    if (autoAnalyzedRef.current.has(conversationIdForAuto)) return;
    autoAnalyzedRef.current.add(conversationIdForAuto);
    void analyzeRef.current();
  }, [canAutoAnalyze, conversationIdForAuto, sentimentForAuto, hasCustomerMessageForAuto]);

  const fetchContactData = useCallback(async (isCancelled: () => boolean) => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch notes and tags in parallel
    const [notesRes, tagsRes] = await Promise.all([
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

    // contact (and thus this whole fetch) may be stale by the time the
    // network round-trip resolves — e.g. the operator switched to a
    // different conversation, or closed the panel — so nothing below
    // should touch state if that happened.
    if (isCancelled()) return;

    if (notesRes.error) {
      console.error("[ContactSidebar] failed to load contact notes:", notesRes.error);
      toast.error("Não foi possível carregar as notas do contato");
    } else if (notesRes.data) {
      setNotes(notesRes.data);
    }

    if (tagsRes.error) {
      console.error("[ContactSidebar] failed to load tags:", tagsRes.error);
    } else if (tagsRes.data) {
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
  // Supabase callbacks, not synchronously in the effect body. `cancelled`
  // guards against the response landing after `contact` has already
  // moved on (fast conversation switching) or the panel unmounted.
  useEffect(() => {
    let cancelled = false;
    fetchContactData(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchContactData]);

  const fetchHistory = useCallback(async (isCancelled: () => boolean) => {
    if (!contact || !accountId) {
      setHistory([]);
      setHistoryHasMore(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const supabase = createClient();
      const rows = await loadContactConversations(supabase, {
        accountId,
        contactId: contact.id,
        limit: HISTORY_FETCH_LIMIT,
      });
      if (isCancelled()) return;
      const withoutCurrent = rows.filter((c) => c.id !== conversation?.id);
      setHistory(withoutCurrent.slice(0, HISTORY_DISPLAY_LIMIT));
      setHistoryHasMore(withoutCurrent.length > HISTORY_DISPLAY_LIMIT);
    } catch (err) {
      console.error("[ContactSidebar] failed to load conversation history:", err);
      if (!isCancelled()) {
        setHistory([]);
        setHistoryHasMore(false);
      }
    } finally {
      if (!isCancelled()) setHistoryLoading(false);
    }
  }, [contact, accountId, conversation?.id]);

  useEffect(() => {
    let cancelled = false;
    fetchHistory(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchHistory]);

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

    if (error) {
      console.error("[ContactSidebar] failed to add contact note:", error);
      toast.error("Erro ao adicionar nota");
    } else if (data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="flex h-full w-[280px] items-center justify-center border-l border-border bg-background px-5">
        <p className="text-center text-xs text-muted-foreground">
          O contexto do contato aparecerá aqui.
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone || "Contato";
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-[280px] flex-col border-l border-border bg-background">
      {/* `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          all sections (Sentimento/Etiquetas/Notas) instead of
          shrinking to the remaining column space — the panel then
          overflows and gets clipped by the parent's overflow-hidden
          with no scrollbar, hiding whatever's below the fold. Same
          fix as conversation-list.tsx's ScrollArea. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <div className="flex items-start gap-3 pb-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted/60 text-sm font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.phone && accountId ? `/api/whatsapp/contacts/avatar?phone=${encodeURIComponent(contact.phone.replace(/^\+/, "").replace(/\s/g, ""))}&account_id=${accountId}` : contact.avatar_url ?? ""}
                  alt={displayName}
                  className="h-11 w-11 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>

            <div className="min-w-0 flex-1">
              {isEditingName ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    aria-label="Nome do contato"
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
                    className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
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
                <button
                  type="button"
                  className="group flex max-w-full items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  onClick={() => setIsEditingName(true)}
                  title="Clique para editar o nome"
                  aria-label={`Editar nome: ${displayName}`}
                >
                  <span className="truncate text-sm font-semibold text-foreground group-hover:text-primary">
                    {displayName}
                  </span>
                  <svg
                    className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    fill="none"
                    aria-hidden="true"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              )}
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {contact.company || "Contato"}
              </p>
            </div>
          </div>

          <div className="border-t border-border/70 py-1.5">
            <button
              onClick={handleCopyPhone}
              className="flex h-8 w-full items-center gap-2 px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left">{contact.phone ?? "Sem telefone"}</span>
              {contact.phone && (
                copied ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                )
              )}
            </button>

            {contact.email && (
              <div className="flex h-8 items-center gap-2 px-1 text-xs text-muted-foreground">
                <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          <div className="mt-3">
            <ContactChannelsCard
              key={contact.id}
              contact={contact}
              canEdit={accountRole !== "viewer"}
              onLinked={(result, merged) => {
                if (merged) onUpdateConversation?.({ contact_id: result.id, contact: result });
                onUpdateContact?.(result);
              }}
            />
          </div>

          {conversation && (
            <SidebarSection
              id="sentimento"
              title="Análise da IA"
              icon={Brain}
              sections={sections}
              onToggle={toggleSection}
              emphasis
              action={
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={analyzing}
                  onClick={handleAnalyzeSentiment}
                  title="Reanalisar sentimento"
                  aria-label="Reanalisar sentimento da conversa"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn("h-3.5 w-3.5", analyzing && "animate-spin")}
                  />
                </Button>
              }
            >
              {(() => {
                const SENTIMENT_CONFIG: Record<
                  string,
                  { color: string; dot: string; label: string; desc: string }
                > = {
                  positive: {
                    color: "text-emerald-700 dark:text-emerald-400",
                    dot: "bg-emerald-500",
                    label: "Positivo",
                    desc: "Aproveite a boa receptividade. Mantenha o atendimento ágil e conduza para o fechamento de forma objetiva."
                  },
                  neutral: {
                    color: "text-muted-foreground",
                    dot: "bg-muted-foreground",
                    label: "Neutro",
                    desc: "Cliente direto e formal. Responda de forma clara, profissional e focada na resolução."
                  },
                  negative: {
                    color: "text-rose-700 dark:text-rose-400",
                    dot: "bg-rose-500",
                    label: "Negativo",
                    desc: "Cliente insatisfeito. Priorize empatia, clareza e resolução antes de avançar na negociação."
                  },
                  mixed: {
                    color: "text-amber-700 dark:text-amber-400",
                    dot: "bg-amber-500",
                    label: "Misto",
                    desc: "Há sinais variados na conversa. Esclareça dúvidas e confirme entendimento antes de avançar."
                  },
                  unknown: {
                    color: "text-muted-foreground",
                    dot: "bg-muted-foreground/50",
                    label: "Não analisado",
                    desc: "A análise roda automaticamente quando houver mensagens suficientes do cliente."
                  }
                };
                const currentSentiment = conversation.sentiment ?? "unknown";
                const config = SENTIMENT_CONFIG[currentSentiment] ?? SENTIMENT_CONFIG.unknown;
                const showSpinner = analyzing && currentSentiment === "unknown";

                return (
                  <div className="rounded-md bg-background/55 px-2.5 py-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                      Sentimento atual
                    </p>

                    {showSpinner ? (
                      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        Analisando a conversa…
                      </div>
                    ) : (
                      <>
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <span className={cn("h-2 w-2 rounded-full", config.dot)} aria-hidden="true" />
                          <span className={cn("text-sm font-semibold", config.color)}>{config.label}</span>
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                          {config.desc}
                        </p>
                      </>
                    )}
                  </div>
                );
              })()}
            </SidebarSection>
          )}

          {/* Quem iniciou a conversa e o que foi enviado (PRD-02). */}
          {conversation && (
            <SidebarSection id="origem" title="Origem" sections={sections} onToggle={toggleSection}>
              <ConversationOriginCard key={conversation.id} conversationId={conversation.id} />
            </SidebarSection>
          )}

          {/* Flow — keyed by conversation so switching conversations
              remounts the card instead of briefly showing the previous
              conversation's runs. */}
          {conversation && canViewFlows && (
            <SidebarSection id="fluxo" title="Fluxo" sections={sections} onToggle={toggleSection}>
              <ConversationFlowCard
                key={conversation.id}
                conversationId={conversation.id}
                canOpenEditor={canOpenFlowEditor}
              />
            </SidebarSection>
          )}

          {/* Tags */}
          <SidebarSection
            id="etiquetas"
            title="Etiquetas"
            icon={TagIcon}
            count={tags.length}
            sections={sections}
            onToggle={toggleSection}
          >
            <div className="flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">Sem etiquetas</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 text-xs text-foreground"
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </SidebarSection>

          {/* Notes */}
          <SidebarSection
            id="notas"
            title="Notas"
            icon={StickyNote}
            count={notes.length}
            sections={sections}
            onToggle={toggleSection}
          >
            <div>
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Adicionar uma nota..."
                  aria-label="Nova nota"
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                  aria-label="Adicionar nota"
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
                    <p className="mt-1 text-xs text-muted-foreground">
                      {format(new Date(note.created_at), "dd/MM/yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </SidebarSection>

          {/* History — reuses loadContactConversations/ConversationCard
              from the /historico feature as-is, just capped to 5 and
              excluding the currently-open conversation. */}
          <SidebarSection
            id="historico"
            title="Histórico"
            icon={History}
            sections={sections}
            onToggle={toggleSection}
            action={
              historyHasMore ? (
                <Link href="/historico" className="text-xs font-medium text-primary hover:underline">
                  Ver todos
                </Link>
              ) : null
            }
          >
            <div className="space-y-2">
              {historyLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : history.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">Nenhuma conversa anterior</p>
              ) : (
                history.map((c) => (
                  <ConversationCard
                    key={c.id}
                    conversation={c}
                    agentName={null}
                    teamName={null}
                    contactInitial={initials}
                  />
                ))
              )}
            </div>
          </SidebarSection>
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Seções recolhíveis do painel ─────────────────────────────────────
// Aberto/fechado por seção fica no localStorage (por navegador). Padrão:
// Notas aberta; Origem, Fluxo, Etiquetas e Histórico fechadas.
const SIDEBAR_SECTIONS_KEY = "wacrm:inbox:sidebar-sections:v2";
type SidebarSectionId = "sentimento" | "origem" | "fluxo" | "etiquetas" | "notas" | "historico";
type SectionsState = Record<SidebarSectionId, boolean>;
const DEFAULT_SECTIONS: SectionsState = {
  sentimento: true,
  origem: true,
  fluxo: false,
  etiquetas: true,
  notas: true,
  historico: false,
};

function useSidebarSections() {
  const [sections, setSections] = useState<SectionsState>(DEFAULT_SECTIONS);

  // Preferências v2 são overrides explícitos. Assim "Análise da IA" e
  // "Origem" nascem abertas e só ficam fechadas em próximos acessos se o
  // próprio usuário tiver fechado essas seções.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_SECTIONS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const valid: Partial<SectionsState> = {};
      (Object.keys(DEFAULT_SECTIONS) as SidebarSectionId[]).forEach((key) => {
        if (typeof parsed[key] === "boolean") valid[key] = parsed[key];
      });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hidrata preferência local uma vez
      setSections((prev) => ({ ...prev, ...valid }));
    } catch {
      // Preferência é opcional; ignora storage indisponível/corrompido.
    }
  }, []);

  const toggleSection = useCallback((id: SidebarSectionId) => {
    setSections((prev) => {
      const value = !prev[id];
      const next = { ...prev, [id]: value };

      try {
        const raw = window.localStorage.getItem(SIDEBAR_SECTIONS_KEY);
        const stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        window.localStorage.setItem(
          SIDEBAR_SECTIONS_KEY,
          JSON.stringify({ ...stored, [id]: value }),
        );
      } catch {
        // best-effort
      }

      return next;
    });
  }, []);

  return { sections, toggleSection };
}

function SidebarSection({
  id,
  title,
  icon: Icon,
  count,
  action,
  sections,
  onToggle,
  children,
  emphasis = false,
}: {
  id: SidebarSectionId;
  title: string;
  icon?: LucideIcon;
  count?: number;
  action?: ReactNode;
  sections: SectionsState;
  onToggle: (id: SidebarSectionId) => void;
  children: ReactNode;
  emphasis?: boolean;
}) {
  const open = sections[id];
  const contentId = `sidebar-section-${id}`;
  return (
    <section
      className={cn(
        "py-1",
        emphasis
          ? "my-2 rounded-lg border border-primary/20 bg-primary/[0.04] px-2"
          : "border-t border-border/70",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={open}
          aria-controls={contentId}
          className={cn(
            "flex h-9 min-w-0 flex-1 items-center gap-2 px-1 text-left text-xs font-medium transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
            emphasis ? "text-foreground" : "text-foreground",
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          {Icon && (
            <Icon
              className={cn("h-4 w-4 shrink-0", emphasis ? "text-primary" : "text-muted-foreground")}
              aria-hidden="true"
            />
          )}
          <span className="truncate">{title}</span>
          {count !== undefined && count > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground/75">{count}</span>
          )}
        </button>
        {action}
      </div>
      {open && (
        <div id={contentId} className="px-1 pb-3 pt-1">
          {children}
        </div>
      )}
    </section>
  );
}