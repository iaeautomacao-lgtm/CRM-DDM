"use client";

/**
 * Botão "Histórico" + diálogo com as versões salvas de um prompt da IA
 * (migration 148 · GET /api/ai/prompt-versions). Usado em
 * Configurações → IA e no nó de IA do editor de fluxos.
 *
 * "Restaurar" só devolve o texto para o campo — o usuário ainda precisa
 * salvar (ou publicar o fluxo) para a versão voltar a valer.
 */

import { useCallback, useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api-fetch";
import { lineDiffStats, promptPreview } from "@/lib/ai/prompt-diff";

type Source = "ui" | "migration" | "restore" | "backfill";

interface PromptVersionItem {
  id: string;
  version: string;
  content: string;
  source: Source;
  created_at: string;
  created_by_name: string | null;
  last_saved_at: string;
  last_saved_by_name: string | null;
}

const SOURCE_LABEL: Record<Source, string> = {
  ui: "Tela",
  migration: "Migration",
  restore: "Restaurado",
  backfill: "Versão inicial",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export type PromptHistoryTarget =
  | { scope: "account" }
  | { scope: "flow_node"; flowId: string; nodeKey: string };

export function PromptHistoryButton({
  target,
  currentContent,
  onRestore,
  disabled,
  description,
}: {
  target: PromptHistoryTarget;
  /** Texto atual do campo — marca a versão igual e calcula o "+/− linhas". */
  currentContent: string;
  onRestore: (content: string) => void;
  disabled?: boolean;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<PromptVersionItem[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ scope: target.scope });
      if (target.scope === "flow_node") {
        params.set("flow_id", target.flowId);
        params.set("node_key", target.nodeKey);
      }
      const res = await apiFetch(`/api/ai/prompt-versions?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Falha ao carregar o histórico");
      setVersions((json.versions ?? []) as PromptVersionItem[]);
    } catch (err) {
      setVersions([]);
      toast.error(err instanceof Error ? err.message : "Falha ao carregar o histórico");
    } finally {
      setLoading(false);
    }
  }, [target]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setExpanded(null);
      void load();
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={disabled}
        onClick={() => handleOpenChange(true)}
      >
        <History />
        Histórico
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Histórico do prompt</DialogTitle>
            <DialogDescription>
              {description ??
                "Versões salvas deste prompt, da mais recente para a mais antiga. Restaurar coloca o texto de volta no campo; ele só passa a valer depois de salvar."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : versions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nenhuma versão registrada ainda. As versões passam a ser guardadas a cada salvamento.
              </p>
            ) : (
              versions.map((v) => {
                const isCurrent = v.content === currentContent;
                const diff = isCurrent ? null : lineDiffStats(currentContent, v.content);
                const author = v.last_saved_by_name ?? v.created_by_name;
                const isOpen = expanded === v.id;
                return (
                  <div key={v.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-foreground">
                        {formatDate(v.last_saved_at)}
                      </span>
                      <code className="text-[10px] text-muted-foreground">{v.version}</code>
                      <Badge variant="outline">{SOURCE_LABEL[v.source] ?? v.source}</Badge>
                      {isCurrent && <Badge variant="secondary">Texto atual</Badge>}
                      {author && (
                        <span className="text-[11px] text-muted-foreground">por {author}</span>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        {diff && (
                          <span className="text-[10px] text-muted-foreground">
                            +{diff.added} / −{diff.removed} linhas
                          </span>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={isCurrent || disabled}
                          onClick={() => {
                            onRestore(v.content);
                            setOpen(false);
                            toast.success("Versão restaurada no campo. Salve para aplicar.");
                          }}
                        >
                          <RotateCcw />
                          Restaurar
                        </Button>
                      </div>
                    </div>
                    {isOpen ? (
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px] text-foreground">
                        {v.content}
                      </pre>
                    ) : (
                      <p className="mt-2 text-[11px] text-muted-foreground">{promptPreview(v.content)}</p>
                    )}
                    <button
                      type="button"
                      className="mt-1 text-[11px] text-primary hover:underline"
                      onClick={() => setExpanded(isOpen ? null : v.id)}
                    >
                      {isOpen ? "Ocultar texto" : "Ver texto completo"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
