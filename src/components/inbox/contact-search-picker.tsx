"use client";

// ContactSearchPicker — command-palette-styled contact search for
// "Nova conversa" (inbox/page.tsx). There's no cmdk dependency in this
// codebase (grepped package.json + src/components/ui — confirmed
// absent), so this reuses the existing Dialog + Input primitives in
// the same "search box on top, live-filtered list below" shape cmdk
// gives you, rather than pulling in a new package for one screen.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Search } from "lucide-react";
import type { Contact } from "@/types";

interface ContactSearchPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (contact: Contact) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const RESULT_LIMIT = 20;

export function ContactSearchPicker({
  open,
  onOpenChange,
  onSelect,
}: ContactSearchPickerProps) {
  const { accountId } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);

  // Reset happens in event handlers (dialog close, input change), not in
  // an effect reacting to `open`/`query` — calling setState synchronously
  // in an effect body trips react-hooks/set-state-in-effect. Same
  // handleOpenChange-wraps-onOpenChange shape template-picker.tsx already
  // uses for its own reset-on-close.
  function resetSearch() {
    setQuery("");
    setResults([]);
    setLoading(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetSearch();
    onOpenChange(next);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    if (!value.trim()) {
      setResults([]);
      setLoading(false);
    } else {
      setLoading(true);
    }
  }

  useEffect(() => {
    if (!open || !accountId) return;
    const trimmed = query.trim();
    if (!trimmed) return;

    const timer = setTimeout(async () => {
      const supabase = createClient();
      // Same escaping concern as contacts/page.tsx's search — a raw "%"
      // or "," in the term would otherwise break the PostgREST filter
      // string this .or() call builds.
      const escaped = trimmed.replace(/[%,]/g, "");
      const { data, error } = await supabase
        .from("contacts")
        .select("id, name, phone, avatar_url")
        .eq("account_id", accountId)
        .or(`name.ilike.%${escaped}%,phone.ilike.%${escaped}%`)
        .limit(RESULT_LIMIT);

      if (error) {
        console.error("[ContactSearchPicker] search error:", error);
        setResults([]);
      } else {
        setResults((data ?? []) as Contact[]);
      }
      setLoading(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, accountId, query]);

  function handleSelect(contact: Contact) {
    onSelect(contact);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border px-4 pb-3 pt-4">
          <DialogTitle className="text-popover-foreground">Nova conversa</DialogTitle>
        </DialogHeader>

        <div className="px-4 pb-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Buscar por nome ou telefone..."
              className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
            />
          </div>

          <div className="mt-3 max-h-80 space-y-0.5 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : !query.trim() ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Digite um nome ou telefone para buscar.
              </p>
            ) : results.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Nenhum contato encontrado.
              </p>
            ) : (
              results.map((contact) => {
                const displayName = contact.name || contact.phone || "Sem nome";
                return (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() => handleSelect(contact)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
                  >
                    <Avatar className="size-8 shrink-0">
                      {contact.avatar_url ? (
                        <AvatarImage src={contact.avatar_url} alt={displayName} />
                      ) : null}
                      <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                        {displayName.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-popover-foreground">{displayName}</p>
                      {contact.phone && (
                        <p className="truncate text-xs text-muted-foreground">{contact.phone}</p>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
