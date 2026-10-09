"use client";

/**
 * Validation panel — surfaces every error and warning from
 * `validateFlowForActivation`. Lives once at the bottom of the
 * editor shell so it's visible in both views (canvas + list).
 *
 * Node-scoped issues are clickable: tapping one calls
 * `requestFlash(node_key)` on the editor context. List view's
 * useEffect on `flashKey` expands + scrolls + flashes the row;
 * canvas view's useEffect pans the viewport + flashes the card.
 * Both views read the same flashKey so the panel doesn't need
 * per-view plumbing.
 *
 * Trigger-scoped issues are NOT clickable from canvas — trigger
 * config is a list-only panel (it's a flat form, not a graph
 * concept). User can switch to List to address them.
 */

import { CircleCheck, CircleX, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ValidationIssue } from "@/lib/flows/validate";
import { useFlowEditor } from "./flow-editor-state";

/** Small "X" button shared by both branches below — collapses the
 *  panel via the shell's `onClose`, which persists the choice to
 *  localStorage (see flow-editor-shell.tsx). */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Fechar painel de validação"
      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

export function ValidationPanel({ onClose }: { onClose: () => void }) {
  const { issues, requestFlash } = useFlowEditor();

  if (issues.length === 0) {
    // Slate-950 base + emerald accents so the panel stays readable when
    // sticky-positioned over scrolled-behind node cards (a translucent
    // bg-success-soft would bleed through ugly).
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/50 bg-background p-3 text-sm font-medium text-success">
        <CircleCheck className="h-4 w-4 shrink-0" />
        <span className="flex-1">Nenhum problema. Pronto para ativar.</span>
        <CloseButton onClose={onClose} />
      </div>
    );
  }
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return (
    <div
      className={cn(
        "rounded-lg border bg-background p-3",
        errors.length > 0 ? "border-danger/40" : "border-warning/40",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          {errors.length > 0 ? (
            <CircleX className="h-4 w-4 text-danger" aria-hidden="true" />
          ) : (
            <TriangleAlert className="h-4 w-4 text-warning" aria-hidden="true" />
          )}
          {errors.length} erro{errors.length === 1 ? "" : "s"},{" "}
          {warnings.length} aviso{warnings.length === 1 ? "" : "s"}
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {issues.map((i, ix) => (
          <IssueLine key={ix} issue={i} onJump={requestFlash} />
        ))}
      </div>
    </div>
  );
}

/**
 * Floating reopen affordance — rendered over the stage (canvas/list)
 * by flow-editor-shell.tsx when the panel above is collapsed. Reads
 * `issues` from the same context so its counts never drift from the
 * panel it reopens.
 */
export function ValidationPanelBadge({ onClick }: { onClick: () => void }) {
  const { issues } = useFlowEditor();
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Reabrir painel de validação"
      className={cn(
        "absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-md transition-colors hover:bg-muted",
        errors > 0
          ? "border-danger/40 text-danger"
          : warnings > 0
            ? "border-warning/40 text-warning"
            : "border-success/50 text-success",
      )}
    >
      {errors === 0 && warnings === 0 ? (
        <CircleCheck className="h-3.5 w-3.5 shrink-0" />
      ) : (
        errors > 0 ? (
          <CircleX className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
        )
      )}
      {errors} erro{errors === 1 ? "" : "s"}, {warnings} aviso
      {warnings === 1 ? "" : "s"}
    </button>
  );
}

/**
 * Exported so the per-node card (list view) and the trigger panel
 * can render the same "icon + node key chip + message" formatting
 * for their own per-row issue lists without re-implementing the
 * tone / icon / accessibility logic.
 */
export function IssueLine({
  issue,
  onJump,
}: {
  issue: ValidationIssue;
  onJump?: (key: string) => void;
}) {
  const isError = issue.severity === "error";
  const tone = isError ? "text-danger" : "text-warning";
  const SeverityIcon = isError ? CircleX : TriangleAlert;
  const body = (
    <>
      <SeverityIcon className={cn("mt-0.5 h-3 w-3 shrink-0", tone)} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="mr-1 font-semibold">{isError ? "Erro:" : "Aviso:"}</span>
        {issue.node_key && (
          <code className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
            {issue.node_key}
          </code>
        )}
        {issue.message}
      </span>
    </>
  );

  // Only node-scoped issues can jump; trigger-scoped issues have no
  // destination (the trigger panel is list-only and already at the
  // top of that view).
  if (issue.node_key && onJump) {
    return (
      <button
        type="button"
        onClick={() => onJump(issue.node_key!)}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted/60",
          tone,
        )}
        title={`Ir para o nó ${issue.node_key}`}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1 text-xs",
        tone,
      )}
    >
      {body}
    </div>
  );
}
