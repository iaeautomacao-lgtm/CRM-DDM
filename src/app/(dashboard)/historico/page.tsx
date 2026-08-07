"use client";

// ============================================================
// /historico — "Histórico de Conversa": search a contact, then see
// their full timeline of past conversations (ContactTimeline).
//
// Not a nav entry anymore — the main entry point is the "Ver
// histórico" action on a Monitoramento card, which opens
// ContactTimelineModal in place instead of navigating here. This page
// is kept as a manual-search fallback for direct URL access.
// ============================================================

import { useEffect, useState } from "react";
import { History, Search, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmptyState } from "@/components/dashboard/empty-state";
import type { Contact } from "@/types";
import { ContactTimeline } from "@/components/contact-timeline/ContactTimeline";

function contactInitial(contact: { name?: string; phone: string }) {
  return (contact.name?.trim() || contact.phone).charAt(0).toUpperCase();
}

export default function HistoricoPage() {
  const { accountId } = useAuth();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selected, setSelected] = useState<Contact | null>(null);

  useEffect(() => {
    if (!accountId || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const db = createClient();
        const like = query.trim().replace(/[%,]/g, "");
        const { data, error } = await db
          .from("contacts")
          .select("*")
          .eq("account_id", accountId)
          .or(`name.ilike."%${like}%",phone.ilike."%${like}%"`)
          .order("name")
          .limit(10);
        if (cancelled) return;
        if (error) {
          console.error("[historico] contact search failed:", error);
          setResults([]);
        } else {
          setResults((data ?? []) as Contact[]);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accountId, query]);

  function handleSelect(contact: Contact) {
    setSelected(contact);
    setQuery("");
    setResults([]);
    setShowResults(false);
  }

  function handleClear() {
    setSelected(null);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Histórico de Conversa</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Linha do tempo de atendimentos por contato.
        </p>
      </div>

      <div className="relative rounded-xl border border-border bg-card p-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowResults(true);
            }}
            onFocus={() => setShowResults(true)}
            placeholder="Buscar contato por nome ou telefone..."
            className="pl-9"
          />
        </div>

        {showResults && query.trim().length >= 2 && (
          <div className="absolute inset-x-4 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover shadow-md">
            {searching ? (
              <p className="p-3 text-sm text-muted-foreground">Buscando…</p>
            ) : results.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">Nenhum contato encontrado.</p>
            ) : (
              results.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => handleSelect(contact)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted"
                >
                  <Avatar className="size-8">
                    <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                      {contactInitial(contact)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {contact.name || contact.phone}
                    </p>
                    <p className="text-xs text-muted-foreground">{contact.phone}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {selected ? (
        <div>
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={handleClear}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
              Limpar seleção
            </button>
          </div>
          <ContactTimeline
            contactId={selected.id}
            contactName={selected.name || selected.phone || "Contato"}
            contactInitial={contactInitial(selected)}
          />
        </div>
      ) : (
        <EmptyState
          icon={History}
          title="Nenhum contato selecionado"
          hint="Busque um contato por nome ou telefone acima para ver a linha do tempo de atendimentos."
          className="min-h-64"
        />
      )}
    </div>
  );
}
