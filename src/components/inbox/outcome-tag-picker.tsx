"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { Tag } from "@/types";
import {
  loadOutcomeTagsForConversation,
  preselectedOutcomeTagId,
  suggestionSourceLabel,
  type OutcomeSuggestionView,
} from "@/lib/conversations/outcome-tags";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, Loader2, Tag as TagIcon } from "lucide-react";

interface OutcomeTagPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (tag: Tag) => void;
  /** Com a conversa, a lista respeita as tabulações da equipe e a IA sugere. */
  conversationId?: string;
}

/**
 * Lista de tabulações da conversa: com conversationId, as tags de desfecho
 * da conta filtradas pela equipe (team_outcome_tags); sem, todas as tags
 * de desfecho visíveis (RLS da conta).
 */
async function loadTags(conversationId: string | undefined): Promise<Tag[]> {
  const supabase = createClient() as unknown as SupabaseClient;
  if (conversationId) {
    const { data: conv } = await supabase
      .from("conversations")
      .select("account_id, team_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (conv?.account_id) {
      return loadOutcomeTagsForConversation(supabase, conv.account_id, conv.team_id);
    }
  }
  const { data, error } = await supabase
    .from("tags")
    .select("*")
    .eq("kind", "outcome")
    .order("name");
  if (error) {
    console.error("Failed to fetch tags:", error);
    return [];
  }
  return (data as Tag[]) ?? [];
}

export function OutcomeTagPicker({
  open,
  onOpenChange,
  onSelect,
  conversationId,
}: OutcomeTagPickerProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [aiSuggestion, setAiSuggestion] = useState<OutcomeSuggestionView | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  // null = nada escolhido ainda (a pré-seleção da sugestão pode entrar).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const loadAiSuggestion = useCallback(async (selectedConversationId: string) => {
    setAiLoading(true);
    setAiSuggestion(null);

    try {
      const response = await fetch(`/api/conversations/${selectedConversationId}/suggest-tag`);
      const data = await response.json();
      if (data.suggestion) setAiSuggestion(data.suggestion as OutcomeSuggestionView);
    } catch {
      // Ignore AI suggestion fetch failures; the user can still pick a tag manually.
    } finally {
      setAiLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      // O pai pode fechar o diálogo direto pela prop `open` (sem passar
      // por handleOpenChange): zera a escolha da conversa anterior.
      setSelectedId(null);
      setTouched(false);
      setLoading(true);
      const loaded = await loadTags(conversationId);
      if (cancelled) return;
      setTags(loaded);
      setLoading(false);
    })();

    // Buscar sugestão da IA em paralelo com as tags
    if (conversationId) {
      void loadAiSuggestion(conversationId);
    }

    return () => {
      cancelled = true;
    };
  }, [open, conversationId, loadAiSuggestion]);

  // Pré-seleção: sugestão do fluxo sempre; do LLM só com confiança
  // suficiente — e nunca por cima de uma escolha do atendente.
  const preselectedId = useMemo(
    () => preselectedOutcomeTagId(tags, aiSuggestion),
    [tags, aiSuggestion],
  );
  const effectiveSelectedId = touched ? selectedId : selectedId ?? preselectedId;
  const selectedTag = tags.find((t) => t.id === effectiveSelectedId) ?? null;

  function choose(tagId: string) {
    setTouched(true);
    setSelectedId(tagId);
  }

  function confirm(tag: Tag | null = selectedTag) {
    if (tag) onSelect(tag);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSearch("");
      setAiSuggestion(null);
      setAiLoading(false);
      setSelectedId(null);
      setTouched(false);
    }
    onOpenChange(next);
  }

  const filtered = tags.filter((t) =>
    t.name.toLowerCase().includes(search.trim().toLowerCase())
  );
  const suggestionInList =
    aiSuggestion !== null && tags.some((t) => t.id === aiSuggestion.tag_id);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <TagIcon className="h-4 w-4 text-primary" />
            Tag de encerramento
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Escolha o resultado deste atendimento antes de fechar a conversa.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              confirm();
            }
          }}
          placeholder="Buscar tag..."
          aria-label="Buscar tag de desfecho"
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          autoFocus
        />

        {/* Sugestão da IA / do fluxo */}
        {(aiLoading || (aiSuggestion && suggestionInList)) && (
          <div className="mb-3">
            {aiLoading && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                Analisando conversa...
              </div>
            )}
            {!aiLoading && aiSuggestion && suggestionInList && (
              <button
                type="button"
                onClick={() => choose(aiSuggestion.tag_id)}
                className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                  effectiveSelectedId === aiSuggestion.tag_id
                    ? "border-primary bg-primary/10"
                    : "border-primary/40 bg-primary/5 hover:bg-primary/10"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-primary uppercase tracking-wide">
                    ✨ Sugestão · {suggestionSourceLabel(aiSuggestion.source)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {Math.round(aiSuggestion.confidence * 100)}% de confiança
                  </span>
                </div>
                <p className="text-sm font-medium text-foreground">
                  {aiSuggestion.tag_name}
                </p>
                {aiSuggestion.motivo && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {aiSuggestion.motivo}
                  </p>
                )}
              </button>
            )}
          </div>
        )}

        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhuma tag encontrada
            </p>
          ) : (
            filtered.map((tag) => {
              const isSelected = tag.id === effectiveSelectedId;
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => choose(tag.id)}
                  onDoubleClick={() => confirm(tag)}
                  className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm text-popover-foreground transition-colors hover:border-primary/40 hover:bg-popover ${
                    isSelected ? "border-primary bg-primary/10" : "border-border bg-background/50"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="flex-1">{tag.name}</span>
                  {isSelected && <Check className="h-4 w-4 text-primary" />}
                </button>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-popover-foreground hover:bg-muted"
          >
            Cancelar
          </Button>
          <Button onClick={() => confirm()} disabled={!selectedTag}>
            Encerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
