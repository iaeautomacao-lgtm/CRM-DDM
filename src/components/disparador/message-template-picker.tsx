"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { DisparadorMessageTemplate } from "@/types";
import { TEMPLATE_VARS } from "@/lib/disparador/template-vars";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

interface MessageTemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: DisparadorMessageTemplate) => void;
}

type Mode = "list" | "create";

export function MessageTemplatePicker({
  open,
  onOpenChange,
  onSelect,
}: MessageTemplatePickerProps) {
  const { accountId, user } = useAuth();
  const [templates, setTemplates] = useState<DisparadorMessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("list");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nome, setNome] = useState("");
  const [conteudo, setConteudo] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadTemplates = async () => {
    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("disparador_message_templates")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to fetch message templates:", error);
      setTemplates([]);
    } else {
      setTemplates((data as DisparadorMessageTemplate[]) ?? []);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!open) return;
    setMode("list");
    setSearch("");
    void loadTemplates();
  }, [open]);

  function resetCreateForm() {
    setEditingId(null);
    setNome("");
    setConteudo("");
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetCreateForm();
    onOpenChange(next);
  }

  function handleEditClick(template: DisparadorMessageTemplate) {
    setEditingId(template.id);
    setNome(template.nome);
    setConteudo(template.conteudo);
    setMode("create");
  }

  function insertVar(variable: string) {
    const el = contentRef.current;
    const start = el?.selectionStart ?? conteudo.length;
    const end = el?.selectionEnd ?? conteudo.length;
    const updated = conteudo.slice(0, start) + variable + conteudo.slice(end);
    setConteudo(updated);
    const cursorPos = start + variable.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursorPos, cursorPos);
    });
  }

  // Extracts plain text from the uploaded file into the content field for
  // the user to review/edit — it does NOT save automatically.
  async function handleFileImport(file: File) {
    setImporting(true);
    try {
      const name = file.name.toLowerCase();
      let text: string;

      if (name.endsWith(".docx")) {
        const mammoth = await import("mammoth");
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result.value;
      } else if (name.endsWith(".txt")) {
        text = await file.text();
      } else {
        toast.error("Formato não suportado. Use .docx ou .txt.");
        return;
      }

      setConteudo(text.trim());
      if (!nome.trim()) {
        setNome(file.name.replace(/\.(docx|txt)$/i, ""));
      }
      toast.success("Texto importado — revise antes de salvar.");
    } catch (err) {
      console.error("Failed to import template file:", err);
      toast.error("Falha ao importar o arquivo.");
    } finally {
      setImporting(false);
    }
  }

  async function handleSave() {
    if (!accountId || !user) {
      toast.error("Não autenticado");
      return;
    }
    if (!nome.trim() || !conteudo.trim()) {
      toast.error("Preencha o nome e o conteúdo do template");
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = editingId
        ? await supabase
            .from("disparador_message_templates")
            .update({ nome: nome.trim(), conteudo: conteudo.trim() })
            .eq("id", editingId)
        : await supabase.from("disparador_message_templates").insert({
            account_id: accountId,
            nome: nome.trim(),
            conteudo: conteudo.trim(),
          });
      if (error) throw error;

      toast.success(editingId ? "Template atualizado" : "Template criado");
      resetCreateForm();
      setMode("list");
      await loadTemplates();
    } catch (err) {
      console.error("Failed to save message template:", err);
      toast.error("Falha ao salvar o template");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(template: DisparadorMessageTemplate) {
    const confirmed = window.confirm(`Excluir o template "${template.nome}"?`);
    if (!confirmed) return;

    const supabase = createClient();
    const { error } = await supabase
      .from("disparador_message_templates")
      .delete()
      .eq("id", template.id);

    if (error) {
      toast.error("Falha ao excluir o template");
      return;
    }
    setTemplates((prev) => prev.filter((t) => t.id !== template.id));
  }

  const filtered = templates.filter((t) =>
    t.nome.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            {mode === "create" ? (editingId ? "Editar template" : "Novo template") : "Templates de mensagem"}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {mode === "create"
              ? "Escreva o texto ou importe de um arquivo .docx/.txt — revise antes de salvar."
              : "Escolha um template para carregar na mensagem da campanha."}
          </DialogDescription>
        </DialogHeader>

        {mode === "list" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar template..."
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
              <Button
                type="button"
                variant="secondary"
                className="shrink-0"
                onClick={() => setMode("create")}
              >
                <Plus className="h-4 w-4" />
                Novo
              </Button>
            </div>

            <div className="max-h-[50vh] space-y-2 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                  <p className="text-sm text-popover-foreground">Nenhum template</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Crie um template manualmente ou importe de um arquivo .docx/.txt.
                  </p>
                </div>
              ) : (
                filtered.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-background/50 p-3 transition-colors hover:border-primary/40"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(t);
                        handleOpenChange(false);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm font-medium text-popover-foreground">
                        {t.nome}
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {t.conteudo}
                      </p>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => handleEditClick(t)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-red-500 hover:bg-red-500/10"
                      onClick={() => handleDelete(t)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                ))
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                Fechar
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Nome do template"
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />

            <div className="space-y-1.5">
              <textarea
                ref={contentRef}
                value={conteudo}
                onChange={(e) => setConteudo(e.target.value)}
                placeholder="Escreva a mensagem..."
                className="w-full min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none resize-none"
              />
              <div className="flex flex-wrap gap-1">
                {TEMPLATE_VARS.map((v) => (
                  <button
                    key={v.value}
                    type="button"
                    onClick={() => insertVar(v.value)}
                    className="px-2 py-0.5 rounded-full border border-border bg-card text-[10px] font-medium text-muted-foreground hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors"
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".docx,.txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileImport(file);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Importar de .docx/.txt
            </Button>

            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  resetCreateForm();
                  setMode("list");
                }}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                Voltar
              </Button>
              <Button
                disabled={saving || !nome.trim() || !conteudo.trim()}
                onClick={handleSave}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {editingId ? "Salvar alterações" : "Salvar template"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
