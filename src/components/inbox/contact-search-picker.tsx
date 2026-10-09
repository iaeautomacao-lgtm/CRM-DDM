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
import { Loader2, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-fetch";
import { usePermission } from "@/hooks/use-permission";
import { Button } from "@/components/ui/button";
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
  // PRD 23, item 5 — criar o contato pelo Inbox (POST /api/contacts,
  // contacts.edit). Mesmo número de um contato existente não duplica: a API
  // devolve o existente e a conversa segue com ele.
  const canCreate = usePermission("contacts.edit");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [saving, setSaving] = useState(false);

  function startCreate() {
    const digits = query.replace(/\D/g, "");
    setNewPhone(digits.length >= 8 ? digits : "");
    setNewName(digits.length >= 8 ? "" : query.trim());
    setCreating(true);
  }

  async function submitCreate() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await apiFetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() || undefined, phone: newPhone }),
      });
      const json = (await res.json().catch(() => ({}))) as { contact?: Contact; created?: boolean; error?: string };
      if (!res.ok || !json.contact) {
        toast.error(json.error ?? "Não foi possível criar o contato");
        return;
      }
      toast.success(json.created ? "Contato criado" : "Esse número já era de um contato — usando o existente");
      handleSelect(json.contact);
    } finally {
      setSaving(false);
    }
  }

  // Reset happens in event handlers (dialog close, input change), not in
  // an effect reacting to `open`/`query` — calling setState synchronously
  // in an effect body trips react-hooks/set-state-in-effect. Same
  // handleOpenChange-wraps-onOpenChange shape template-picker.tsx already
  // uses for its own reset-on-close.
  function resetSearch() {
    setQuery("");
    setResults([]);
    setLoading(false);
    setCreating(false);
    setNewName("");
    setNewPhone("");
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
        .select("id, name, phone, avatar_url, instituicao")
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

        {creating ? (
          <form
            className="flex animate-ddm-fade flex-col gap-3 px-4 pb-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreate();
            }}
          >
            <label className="flex flex-col gap-1.5 text-[12.5px] font-medium text-foreground">
              Nome
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nome do contato"
                maxLength={200}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[12.5px] font-medium text-foreground">
              Telefone (com DDI e DDD)
              <Input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="5511999999999"
                inputMode="tel"
                required
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Se o número já for de um contato, a conversa segue com ele (sem duplicar).
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCreating(false)} disabled={saving}>
                Voltar
              </Button>
              <Button type="submit" disabled={saving || newPhone.replace(/\D/g, "").length < 8}>
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <UserPlus className="size-4" aria-hidden="true" />}
                Criar e continuar
              </Button>
            </div>
          </form>
        ) : (
        <div className="px-4 pb-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              autoFocus
              type="search"
              aria-label="Buscar contato por nome ou telefone"
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
          {canCreate && (
            <button
              type="button"
              onClick={startCreate}
              className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-dashed border-border-strong text-[13px] font-medium text-foreground-2 hover:border-primary-soft-2 hover:bg-primary-soft hover:text-primary-text"
            >
              <UserPlus className="size-4" aria-hidden="true" />
              Criar contato novo
            </button>
          )}
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
