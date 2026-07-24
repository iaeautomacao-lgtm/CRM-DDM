"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Tag } from "@/types";
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
import { Loader2, Tag as TagIcon } from "lucide-react";

interface OutcomeTagPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (tag: Tag) => void;
}

export function OutcomeTagPicker({
  open,
  onOpenChange,
  onSelect,
}: OutcomeTagPickerProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tags")
        .select("*")
        .order("name");

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch tags:", error);
        setTags([]);
      } else {
        setTags((data as Tag[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (!next) setSearch("");
    onOpenChange(next);
  }

  const filtered = tags.filter((t) =>
    t.name.toLowerCase().includes(search.trim().toLowerCase())
  );

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
          placeholder="Buscar tag..."
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          autoFocus
        />

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
            filtered.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => onSelect(tag)}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-background/50 px-3 py-2 text-left text-sm text-popover-foreground transition-colors hover:border-primary/40 hover:bg-popover"
              >
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </button>
            ))
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
