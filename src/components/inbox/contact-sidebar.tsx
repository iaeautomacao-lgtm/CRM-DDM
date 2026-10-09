"use client";

import { apiFetch } from "@/lib/api-fetch";
import { ConversationOriginCard, useConversationOrigin } from "@/components/inbox/conversation-origin";
import { maskCpf } from "@/lib/privacy/mask";

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
  ChevronDown,
  X,
  Pencil,
  IdCard,
  PhoneOff,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { usePermissions } from "@/hooks/use-permission";

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
  /** Fecha o painel (botão X da barra "Detalhes"). */
  onClose?: () => void;
}

export function ContactSidebar({
  contact,
  conversation,
  onUpdateConversation,
  onUpdateContact,
  onClose,
}: ContactSidebarProps) {
  const { accountId } = useAuth();
  const origin = useConversationOrigin(conversation?.id ?? null);
  // Card "Fluxo" só para owner/admin (o agente não vê o fluxo da conversa).
  // O link para o editor depende de quem pode abrir /flows (ROUTE_ALLOWLIST).
  const { can, canOpen } = usePermissions();
  const canViewFlows = can("flows.view_runs");
  const canOpenFlowEditor = canOpen("/flows");
  const canEditContact = can("contacts.edit");
  const [isEditingCpf, setIsEditingCpf] = useState(false);
  const [cpfDraft, setCpfDraft] = useState("");
  const [savingCpf, setSavingCpf] = useState(false);
  // Nomes do atendente e da equipe para o bloco "Atendimento" (RLS da conta).
  const [assigneeName, setAssigneeName] = useState<string | null>(null);
  // Etiquetas pela API (PRD 23, item 20): `available` = as que o operador
  // pode pôr/tirar (a API já exclui as automáticas da conversa).
  const [availableTags, setAvailableTags] = useState<Tag[] | null>(null);
  const [tagQuery, setTagQuery] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [teamName, setTeamName] = useState<string | null>(null);
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

  // Nome e CPF pela PATCH /api/contacts/[id] (PRD 23, item 4): contacts.edit,
  // validação (CPF com dígito verificador) e auditoria no servidor. O CPF
  // nunca volta em claro da API; a tela guarda o que o próprio operador digitou.
  const patchContact = async (body: { name?: string; cpf?: string | null }): Promise<boolean> => {
    if (!contact) return false;
    const res = await apiFetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(json.error ?? "Não foi possível salvar o contato");
      return false;
    }
    return true;
  };

  const handleSaveName = async () => {
    if (!contact || !editName.trim()) return;
    if (await patchContact({ name: editName.trim() })) {
      onUpdateContact?.({ ...contact, name: editName.trim() });
      setIsEditingName(false);
      toast.success("Nome do contato atualizado");
    }
  };

  const handleSaveCpf = async () => {
    if (!contact || savingCpf) return;
    setSavingCpf(true);
    try {
      const digits = cpfDraft.replace(/\D/g, "");
      if (await patchContact({ cpf: digits || null })) {
        onUpdateContact?.({ ...contact, cpf: digits || null });
        setIsEditingCpf(false);
        toast.success(digits ? "CPF salvo" : "CPF removido");
      }
    } finally {
      setSavingCpf(false);
    }
  };

  // Telefones do contato e o status de cada um (contact_phones, RLS 087) —
  // PRD 23, item 8: o operador marca "número errado" e a escada do
  // disparador deixa de usar (migration 086).
  const [phones, setPhones] = useState<{ ordem: number; phone: string; phone_normalized: string; status: string | null }[]>([]);
  const [phoneBusy, setPhoneBusy] = useState<number | null>(null);
  const phonesContactId = contact?.id ?? null;
  useEffect(() => {
    if (!phonesContactId) return;
    let cancelled = false;
    void createClient()
      .from("contact_phones")
      .select("ordem, phone, phone_normalized, status")
      .eq("contact_id", phonesContactId)
      .order("ordem")
      .then(({ data }) => {
        if (!cancelled) setPhones((data ?? []) as typeof phones);
      });
    return () => {
      cancelled = true;
      setPhones([]);
    };
  }, [phonesContactId]);
  const principalRow = phones.find(
    (p) => (contact?.phone_normalized && p.phone_normalized === contact.phone_normalized) || p.ordem === 1,
  );
  const principalInvalid = principalRow?.status === "invalido";
  const altPhones = phones.filter((p) => p !== principalRow && p.ordem > 1);

  const handleFlagPhone = async (ordem: number, invalid: boolean) => {
    if (!contact || phoneBusy !== null) return;
    setPhoneBusy(ordem);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}/phones/invalid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ordem, status: invalid ? "invalido" : "ativo" }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "Não foi possível atualizar o telefone");
        return;
      }
      const status = invalid ? "invalido" : "ativo";
      setPhones((prev) => {
        const target = ordem === 1 ? principalRow : prev.find((p) => p.ordem === ordem);
        if (target) return prev.map((p) => (p === target ? { ...p, status } : p));
        // Principal ainda sem linha: a API criou com a ordem 1.
        return [...prev, { ordem: 1, phone: contact.phone ?? "", phone_normalized: contact.phone_normalized ?? "", status }];
      });
      toast.success(invalid ? "Marcado como número errado" : "Número voltou a ser usado");
    } finally {
      setPhoneBusy(null);
    }
  };

  // Etiquetas disponíveis do contato (GET /api/contacts/[id]/tags), só para
  // quem pode editar — é a lista do seletor e diz quais chips têm "×".
  const tagsContactId = canEditContact ? contact?.id ?? null : null;
  useEffect(() => {
    if (!tagsContactId) return;
    let cancelled = false;
    apiFetch(`/api/contacts/${tagsContactId}/tags`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { available?: Tag[] } | null) => {
        if (!cancelled) setAvailableTags(json?.available ?? []);
      })
      .catch(() => {
        if (!cancelled) setAvailableTags([]);
      });
    return () => {
      cancelled = true;
      setAvailableTags(null);
    };
  }, [tagsContactId]);

  const editableTagIds = new Set((availableTags ?? []).map((t) => t.id));
  const appliedTagIds = new Set(tags.map((t) => t.id));
  const tagNeedle = tagQuery.trim().toLowerCase();
  const addableTags = (availableTags ?? []).filter(
    (t) => !appliedTagIds.has(t.id) && (!tagNeedle || t.name.toLowerCase().includes(tagNeedle)),
  );

  const handleAddTag = async (tag: Tag) => {
    if (!contact || tagBusy) return;
    setTagBusy(true);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_id: tag.id }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "Não foi possível adicionar a etiqueta");
        return;
      }
      setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, { ...tag, contact_tag_id: tag.id }]));
      setTagQuery("");
    } finally {
      setTagBusy(false);
    }
  };

  const handleRemoveTag = async (tag: Tag) => {
    if (!contact || tagBusy) return;
    setTagBusy(true);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}/tags/${tag.id}`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "Não foi possível remover a etiqueta");
        return;
      }
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
    } finally {
      setTagBusy(false);
    }
  };

  useEffect(() => {
    const agentId = conversation?.assigned_agent_id ?? null;
    const teamId = conversation?.team_id ?? null;
    let cancelled = false;
    const supabase = createClient();
    void Promise.all([
      agentId
        ? supabase.from("profiles").select("full_name").eq("user_id", agentId).limit(1)
        : Promise.resolve({ data: [] as { full_name: string | null }[] }),
      teamId
        ? supabase.from("teams").select("name").eq("id", teamId).limit(1)
        : Promise.resolve({ data: [] as { name: string }[] }),
    ]).then(([agent, team]) => {
      if (cancelled) return;
      const a = (agent.data ?? [])[0] as { full_name: string | null } | undefined;
      setAssigneeName(a ? a.full_name || "Atendente" : null);
      setTeamName(((team.data ?? [])[0] as { name: string } | undefined)?.name ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [conversation?.assigned_agent_id, conversation?.team_id]);

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
  const canAutoAnalyze = can("inbox.ai_assist");
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
      <div className="flex h-full w-full items-center justify-center bg-card px-5">
        <p className="text-center text-xs text-muted-foreground">
          O contexto do contato aparecerá aqui.
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone || "Contato";
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-full flex-col bg-card">
      {/* Barra do painel (redesenho DDM): rótulo + fechar. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border pl-4 pr-2.5">
        <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Detalhes</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar detalhes"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {/* `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          all sections (Sentimento/Etiquetas/Notas) instead of
          shrinking to the remaining column space — the panel then
          overflows and gets clipped by the parent's overflow-hidden
          with no scrollbar, hiding whatever's below the fold. Same
          fix as conversation-list.tsx's ScrollArea. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 border-b border-border p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-sm font-semibold text-foreground-2">
              {contact.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={contact.phone && accountId ? `/api/whatsapp/contacts/avatar?phone=${encodeURIComponent(contact.phone.replace(/^\+/, "").replace(/\s/g, ""))}&account_id=${accountId}` : contact.avatar_url ?? ""}
                  alt={displayName}
                  className="size-11 object-cover"
                />
              ) : (
                initials
              )}
            </span>

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
                    className="h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-card px-2 text-[13px] text-foreground outline-none focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
                    autoFocus
                  />
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-primary-text" onClick={handleSaveName}>
                    Salvar
                  </Button>
                </div>
              ) : canEditContact ? (
                <button
                  type="button"
                  className="group flex max-w-full items-center gap-1.5 rounded-sm text-left"
                  onClick={() => setIsEditingName(true)}
                  title="Clique para editar o nome"
                  aria-label={`Editar nome: ${displayName}`}
                >
                  <span className="truncate font-heading text-[15px] font-semibold text-foreground group-hover:text-primary-text">
                    {displayName}
                  </span>
                  <Pencil
                    className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <p className="truncate font-heading text-[15px] font-semibold text-foreground">{displayName}</p>
              )}
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
                {origin?.client ? (
                  <>
                    <span className="size-[7px] shrink-0 rounded-[2px]" style={{ backgroundColor: origin.client.color }} aria-hidden="true" />
                    <span className="truncate">{origin.client.name}</span>
                  </>
                ) : (
                  <span className="truncate">{contact.company || "Contato"}</span>
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-0.5">
            <div className="-mx-2 flex items-center gap-1">
              <button
                type="button"
                onClick={handleCopyPhone}
                disabled={!contact.phone}
                title={contact.phone ? "Copiar telefone" : undefined}
                className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-foreground hover:bg-surface-hover disabled:hover:bg-transparent"
              >
                <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className={cn("min-w-0 flex-1 truncate tabular-nums", principalInvalid && "text-muted-foreground line-through")}>
                  {contact.phone ?? "Sem telefone"}
                </span>
                {contact.phone && (
                  <span className={cn("inline-flex items-center gap-1 text-[11.5px] font-semibold", copied ? "text-success" : "text-muted-foreground")}>
                    {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
                    {copied ? "Copiado" : "Copiar"}
                  </span>
                )}
              </button>
              {contact.phone && canEditContact && (
                <WrongNumberButton invalid={principalInvalid} busy={phoneBusy === 1} onToggle={() => void handleFlagPhone(1, !principalInvalid)} />
              )}
            </div>
            {principalInvalid && (
              <p className="-mt-0.5 pl-6 text-[11.5px] font-medium text-destructive">Marcado como número errado</p>
            )}
            {altPhones.map((p) => {
              const invalid = p.status === "invalido";
              return (
                <div key={p.ordem} className="-mx-2 flex items-center gap-1">
                  <span className="flex h-8 min-w-0 flex-1 items-center gap-2.5 px-2 text-[13px] text-foreground-2">
                    <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className={cn("min-w-0 flex-1 truncate tabular-nums", invalid && "text-muted-foreground line-through")}>{p.phone}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{invalid ? "número errado" : `alternativo ${p.ordem - 1}`}</span>
                  </span>
                  {canEditContact && (
                    <WrongNumberButton invalid={invalid} busy={phoneBusy === p.ordem} onToggle={() => void handleFlagPhone(p.ordem, !invalid)} />
                  )}
                </div>
              );
            })}

            {contact.email && (
              <div className="flex h-8 min-w-0 items-center gap-2.5 text-[13px] text-foreground-2">
                <Mail className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}

            {/* CPF (PRD 23, item 4): sempre mascarado na tela; edição pela
                PATCH /api/contacts/[id] (contacts.edit, valida dígito e audita). */}
            {isEditingCpf ? (
              <div className="flex items-center gap-1.5 py-0.5">
                <IdCard className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label="CPF do contato"
                  placeholder="000.000.000-00"
                  value={cpfDraft}
                  onChange={(e) => setCpfDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveCpf();
                    else if (e.key === "Escape") setIsEditingCpf(false);
                  }}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-card px-2 text-[13px] tabular-nums text-foreground outline-none focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
                  autoFocus
                />
                <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-primary-text" onClick={() => void handleSaveCpf()} disabled={savingCpf}>
                  {savingCpf ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : "Salvar"}
                </Button>
              </div>
            ) : (
              <div className="flex h-8 items-center gap-2.5 text-[13px]">
                <IdCard className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className={cn("min-w-0 flex-1 truncate tabular-nums", contact.cpf ? "text-foreground" : "text-muted-foreground")}>
                  {contact.cpf ? maskCpf(contact.cpf) : "Sem CPF"}
                  <span className="sr-only"> (CPF)</span>
                </span>
                {canEditContact && (
                  <button
                    type="button"
                    onClick={() => {
                      setCpfDraft("");
                      setIsEditingCpf(true);
                    }}
                    className="rounded px-1 text-[11.5px] font-semibold text-primary-text hover:underline"
                  >
                    {contact.cpf ? "Alterar" : "Adicionar"}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="mt-1">
            <ContactChannelsCard
              key={contact.id}
              contact={contact}
              canEdit={canEditContact}
              onLinked={(result, merged) => {
                if (merged) onUpdateConversation?.({ contact_id: result.id, contact: result });
                onUpdateContact?.(result);
              }}
            />
          </div>
        </div>

        {conversation && (
          <div className="flex flex-col gap-2.5 border-b border-border px-4 py-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Atendimento</p>
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
              <dt className="text-muted-foreground">Atendente</dt>
              <dd className="truncate font-medium text-foreground">{assigneeName ?? "Sem atendente"}</dd>
              {teamName && (
                <>
                  <dt className="text-muted-foreground">Equipe</dt>
                  <dd className="truncate text-foreground">{teamName}</dd>
                </>
              )}
              {origin?.channel && (
                <>
                  <dt className="text-muted-foreground">Linha</dt>
                  <dd className="truncate text-foreground">{origin.line ? `${origin.channel} · ${origin.line}` : origin.channel}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Aberta em</dt>
              <dd className="tabular-nums text-foreground">{format(new Date(conversation.created_at), "dd/MM/yyyy HH:mm")}</dd>
            </dl>
          </div>
        )}

        <div>
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
            {/* PRD 23, item 20: etiquetas pela API (contacts.edit; as automáticas
                da conversa aparecem, mas não saem — a API devolve 409). */}
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.length === 0 && !canEditContact && (
                <p className="text-xs text-muted-foreground">Sem etiquetas</p>
              )}
              {tags.map((tag) => {
                const removable = canEditContact && editableTagIds.has(tag.id);
                return (
                  <span
                    key={tag.contact_tag_id}
                    className="inline-flex h-[22px] animate-ddm-pop items-center gap-1.5 rounded-full border border-border pl-[9px] pr-[9px] text-xs text-foreground"
                  >
                    <span className="size-[7px] rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                    {tag.name}
                    {removable && (
                      <button
                        type="button"
                        onClick={() => void handleRemoveTag(tag)}
                        disabled={tagBusy}
                        aria-label={`Remover etiqueta ${tag.name}`}
                        className="-mr-1 rounded-full p-0.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                );
              })}
              {canEditContact && (
                <Popover>
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border-strong px-[9px] text-xs text-foreground-2 hover:border-muted-foreground hover:text-foreground"
                      />
                    }
                  >
                    <Plus className="size-3" aria-hidden="true" />
                    Etiqueta
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 gap-2 p-2">
                    <input
                      type="search"
                      value={tagQuery}
                      onChange={(e) => setTagQuery(e.target.value)}
                      placeholder="Buscar etiqueta"
                      aria-label="Buscar etiqueta"
                      className="h-8 w-full rounded-md border border-border bg-card px-2 text-[13px] outline-none focus:border-primary"
                    />
                    <div className="max-h-56 overflow-y-auto" role="listbox" aria-label="Etiquetas disponíveis">
                      {addableTags.length === 0 ? (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                          {availableTags === null ? "Carregando…" : "Nenhuma etiqueta para adicionar"}
                        </p>
                      ) : (
                        addableTags.map((tag) => (
                          <button
                            key={tag.id}
                            type="button"
                            role="option"
                            aria-selected={false}
                            disabled={tagBusy}
                            onClick={() => void handleAddTag(tag)}
                            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground hover:bg-surface-hover"
                          >
                            <span className="size-[7px] shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                            <span className="truncate">{tag.name}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
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
    <section className={cn("border-b border-border", emphasis && "bg-primary-soft/40")}>
      <div className="flex items-center justify-between gap-2 pr-3">
        <button
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={open}
          aria-controls={contentId}
          data-no-ripple
          className="flex h-11 min-w-0 flex-1 items-center gap-2 pl-4 text-left hover:bg-surface-hover"
        >
          {Icon && (
            <Icon
              className={cn("size-3.5 shrink-0", emphasis ? "text-primary-text" : "text-muted-foreground")}
              aria-hidden="true"
            />
          )}
          <span className="flex-1 truncate text-[13px] font-semibold text-foreground">{title}</span>
          {count !== undefined && count > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-ddm", !open && "-rotate-90")}
          />
        </button>
        {action}
      </div>
      {open && (
        <div id={contentId} className="animate-ddm-fade px-4 pb-3.5">
          {children}
        </div>
      )}
    </section>
  );
}
/** Marca/desmarca "número errado" (PRD 23, item 8). */
function WrongNumberButton({ invalid, busy, onToggle }: { invalid: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      title={invalid ? "Desfazer: o número volta a ser usado" : "Marcar como número errado (o disparador deixa de usar)"}
      aria-label={invalid ? "Desfazer número errado" : "Marcar como número errado"}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-surface-hover",
        invalid ? "text-destructive" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : invalid ? <Undo2 className="size-3.5" aria-hidden="true" /> : <PhoneOff className="size-3.5" aria-hidden="true" />}
    </button>
  );
}
