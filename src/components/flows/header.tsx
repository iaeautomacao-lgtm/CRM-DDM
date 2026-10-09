"use client";

/**
 * Editor toolbar — barra única do redesenho DDM ("Fluxo Editor"):
 * voltar · nome + descrição (editáveis inline) · status em menu
 * (Rascunho / Ativo / Arquivado) · estado do salvamento | desfazer ·
 * refazer · Diagrama/Lista · Execuções · Testar fluxo · Validação ·
 * mais ações (Excluir) · Salvar/Publicar.
 *
 * Lifted out of flow-builder.tsx so the same toolbar renders above
 * both views in FlowEditorShell. Reads everything from the editor
 * context (`useFlowEditor`); a visualização, o simulador e o painel de
 * validação são estado do shell e chegam por props.
 */

import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleCheck,
  FlaskConical,
  History,
  Loader2,
  MoreHorizontal,
  Redo2,
  Save,
  Trash2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/ddm/segmented";
import { cn } from "@/lib/utils";
import {
  useFlowEditor,
  type BuilderState,
} from "./flow-editor-state";

const STATUS_UI: Record<BuilderState["status"], { label: string; chip: string; dot: string }> = {
  draft: { label: "Rascunho", chip: "bg-surface-3 text-foreground-2", dot: "bg-foreground-2" },
  active: { label: "Ativo", chip: "bg-success-soft text-success", dot: "bg-success" },
  archived: { label: "Arquivado", chip: "bg-surface-3 text-muted-foreground", dot: "bg-muted-foreground" },
};

const STATUS_ORDER: BuilderState["status"][] = ["draft", "active", "archived"];

export type EditorView = "canvas" | "list";

interface EditorHeaderProps {
  /** null = sem alternância (celular força Lista; debug força Diagrama). */
  view: { value: EditorView; onChange: (v: EditorView) => void } | null;
  /** null = simulador indisponível (celular / debug). */
  sim: { open: boolean; onToggle: () => void } | null;
  validation: { open: boolean; onToggle: () => void };
}

export function EditorHeader({ view, sim, validation }: EditorHeaderProps) {
  const router = useRouter();
  const {
    flow,
    state,
    setState,
    dirty,
    saving,
    activating,
    canActivate,
    save,
    saveError,
    confirmLeave,
    setStatus,
    deleteFlow,
    undo,
    redo,
    canUndo,
    canRedo,
    issues,
  } = useFlowEditor();

  // Save before leaving the editor via its own nav actions (back / view
  // runs) — SPA route changes don't fire beforeunload, so this persists
  // edits made in the last <2s before the debounce autosave.
  // Fluxo ativo: sair não publica (PRD-01) — confirmLeave pergunta. Se o
  // salvamento falhar, também pergunta (as edições ficam no rascunho local).
  const navigateAway = async (href: string) => {
    if (!await confirmLeave()) return;
    router.push(href);
  };

  const st = STATUS_UI[state.status];
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const isActive = state.status === "active";

  const savedLabel = saving
    ? "Salvando…"
    : saveError
      ? "Erro ao salvar"
      : dirty
        ? isActive
          ? "Alterações não publicadas"
          : "Alterações não salvas"
        : isActive
          ? "Publicado"
          : "Salvo";

  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-border bg-card px-4 py-2.5">
      {/* ---- esquerda: voltar · nome/descrição · status · salvamento ---- */}
      <button
        type="button"
        onClick={() => navigateAway("/flows")}
        title="Voltar para Fluxos"
        aria-label="Voltar para Fluxos"
        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-foreground-2 transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
      </button>
      <div className="flex min-w-0 flex-[0_1_320px] flex-col">
        <input
          value={state.name}
          onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          placeholder="Nome do fluxo"
          spellCheck={false}
          aria-label="Nome do fluxo"
          className="-ml-1 h-6 rounded border border-transparent bg-transparent px-1 text-sm font-semibold text-foreground outline-none transition-colors hover:border-border focus:border-primary focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <input
          value={state.description}
          onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
          placeholder="Adicione uma descrição curta (interna — o cliente não vê isso)"
          aria-label="Descrição do fluxo"
          className="-ml-1 h-5 rounded border border-transparent bg-transparent px-1 text-xs text-muted-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-border focus:border-primary focus:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={activating}
          aria-label={`Status: ${st.label}. Alterar status`}
          className={cn(
            "inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full pl-2.5 pr-1.5 text-xs font-semibold transition-opacity focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
            st.chip,
          )}
        >
          {activating ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", st.dot)} />
          )}
          {st.label}
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {STATUS_ORDER.map((s) => {
            const blocked = s === "active" && !canActivate && state.status !== "active";
            return (
              <DropdownMenuItem
                key={s}
                disabled={s === state.status || blocked}
                onClick={() => void setStatus(s)}
                title={blocked ? "Corrija os erros da validação antes de ativar" : undefined}
              >
                <span aria-hidden="true" className={cn("size-[7px] rounded-full", STATUS_UI[s].dot)} />
                {s === "draft" && state.status === "active" ? "Pausar (rascunho)" : STATUS_UI[s].label}
                {s === state.status && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <span
        className={cn(
          "whitespace-nowrap text-[11.5px]",
          saveError && !saving ? "text-danger" : dirty ? "text-warning" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {savedLabel}
      </span>
      {/* Falha ao salvar: anunciada a leitores de tela uma vez. */}
      {saveError && !saving && (
        <span role="alert" className="sr-only">
          Erro ao salvar o fluxo: {saveError}
        </span>
      )}

      <span className="flex-1" />

      {/* ---- direita ---- */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          title="Desfazer (Ctrl+Z)"
          aria-label="Desfazer"
          className="flex size-8 items-center justify-center rounded-md text-foreground-2 transition-colors hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Undo2 className="size-4" />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          title="Refazer (Ctrl+Shift+Z)"
          aria-label="Refazer"
          className="flex size-8 items-center justify-center rounded-md text-foreground-2 transition-colors hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Redo2 className="size-4" />
        </button>
      </div>

      {view && (
        <Segmented
          ariaLabel="Visualização do editor"
          value={view.value}
          onChange={view.onChange}
          options={[
            { value: "canvas", label: "Diagrama" },
            { value: "list", label: "Lista" },
          ]}
        />
      )}

      <Button variant="outline" size="sm" onClick={() => navigateAway(`/flows/${flow.id}/runs`)} title="Histórico de execuções">
        <History className="size-3.5" />
        <span className="hidden sm:inline">Execuções</span>
        <span className="rounded bg-surface-3 px-1.5 font-mono text-[11px] text-muted-foreground">
          {flow.execution_count}
        </span>
      </Button>

      {sim && (
        <Button
          variant="outline"
          size="sm"
          onClick={sim.onToggle}
          aria-pressed={sim.open}
          className={cn(sim.open && "border-primary bg-primary-soft text-primary-text hover:bg-primary-soft")}
        >
          <FlaskConical className="size-3.5" />
          Testar fluxo
        </Button>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={validation.onToggle}
        aria-pressed={validation.open}
        title={validation.open ? "Ocultar validação" : "Mostrar validação"}
        className={cn(
          errors > 0 ? "border-danger/50 text-danger hover:text-danger" : warnings > 0 ? "border-warning/50 text-warning hover:text-warning" : "text-success hover:text-success",
        )}
      >
        {errors === 0 && warnings === 0 ? <CircleCheck className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
        {errors > 0
          ? `${errors} erro${errors === 1 ? "" : "s"}`
          : warnings > 0
            ? `${warnings} aviso${warnings === 1 ? "" : "s"}`
            : "Sem problemas"}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Mais ações do fluxo"
          className="flex size-8 items-center justify-center rounded-md text-foreground-2 transition-colors hover:bg-surface-hover data-[popup-open]:bg-surface-hover"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={() => void deleteFlow()}>
            <Trash2 className="size-4" />
            Excluir fluxo
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        onClick={() => void save()}
        disabled={saving}
        size="sm"
        variant={saveError && !saving ? "destructive" : dirty ? "default" : "outline"}
        title={saveError && !saving ? saveError : undefined}
      >
        {saving ? (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            Salvando...
          </>
        ) : saveError ? (
          <>
            <AlertTriangle className="size-3.5" />
            Tentar novamente
          </>
        ) : dirty ? (
          <>
            <Save className="size-3.5" />
            {isActive ? "Publicar alterações" : "Salvar"}
          </>
        ) : (
          <>
            <Check className="size-3.5" />
            {isActive ? "Publicado" : "Salvo"}
          </>
        )}
      </Button>
    </div>
  );
}
