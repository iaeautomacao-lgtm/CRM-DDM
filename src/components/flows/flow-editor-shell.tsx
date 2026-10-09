"use client";

/**
 * View-switcher + chrome for the flow editor.
 *
 * Lays the editor out as one app-like column that fills the dashboard
 * content area (toolbar → mode row → stage → validation bar), matching
 * the Flow Builder design handoff:
 *   - A segmented Canvas / List control on the left of the mode row.
 *   - A node-type legend on the right so the canvas's per-type colors
 *     are decodable at a glance.
 *   - The active view is mounted inside a rounded "stage" that owns its
 *     own scroll/overflow, so the canvas can fill available height and
 *     the list scrolls internally.
 *
 * Why a separate component:
 *   - The page itself stays trivially small (loading + error + this).
 *   - Either view can stay unaware of the other — they share data
 *     (`{flow, nodes}`) and nothing else.
 *
 * View choice persists per-browser via localStorage so a power user
 * who prefers the list isn't fighting the default on every load.
 * Canvas is the default for everyone else — the original user
 * feedback was that the list shape made flows "hard to understand".
 */

import { useEffect, useRef, useState } from "react";
import { Eye } from "lucide-react";
import { format } from "date-fns";

import { FlowBuilder } from "./flow-builder";
import { FlowCanvas } from "./flow-canvas";
import { FlowSimulatorPanel } from "./flow-simulator-panel";
import { FlowEditorProvider, useFlowEditor } from "./flow-editor-state";
import { EditorHeader, type EditorView } from "./header";
import { EditorNotices } from "./editor-notices";
import { ValidationPanel } from "./validation-panel";
import { NODE_META, nodeColors, type NodeType } from "./shared";
import { cn } from "@/lib/utils";
import type { FlowRow, FlowNodeRow } from "@/lib/flows/types";
import type { FlowDebugState } from "@/hooks/use-flow-debug";

/**
 * Below this viewport width we force list view and hide the toggle.
 * Canvas with drag-to-connect on a phone is unusable — handles are
 * ~10px and live finger drags from one node to another aren't a
 * practical workflow. Matches Tailwind's `md` breakpoint.
 */
const MOBILE_BREAKPOINT = "(max-width: 767px)";

type View = EditorView;

const STORAGE_KEY = "wacrm.flowEditor.view";
const VALIDATION_PANEL_STORAGE_KEY = "flows-validation-panel-open";

// Legend covers every node type, derived from NODE_META so a new type
// can't silently go undocumented. NODE_META's key order already reads
// the way a flow flows: start → talk → capture → branch → mutate → end.
const LEGEND_TYPES = Object.keys(NODE_META) as NodeType[];

interface Props {
  initialFlow: FlowRow;
  initialNodes: FlowNodeRow[];
  /** "Debug no editor" state from useFlowDebug() — optional so every
   *  other FlowEditorShell consumer (there is currently only the one
   *  in flows/[id]/page.tsx) keeps compiling unchanged. */
  debug?: FlowDebugState;
  /** `?node=` da URL: nó a centralizar/destacar ao abrir (atalho do
   *  card "Fluxo" no inbox). Ignorado se o nó não existir no fluxo. */
  focusNodeKey?: string | null;
}

export function FlowEditorShell({ initialFlow, initialNodes, debug, focusNodeKey }: Props) {
  // Read the persisted choice in the useState initializer. Safe even
  // though this is a client component because the parent page only
  // mounts us AFTER a client-side fetch resolves — there's no SSR
  // pass for this subtree, so no hydration mismatch to worry about.
  // Default to `canvas` (the new default) when nothing is saved.
  const [view, setView] = useState<View>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "canvas" || saved === "list") return saved;
    } catch {
      // Private browsing / disabled storage — fall through to default.
    }
    return "canvas";
  });

  // Live mobile detection. We don't render canvas under the
  // breakpoint regardless of `view` — but we keep `view` itself
  // intact so the user's preference comes back when they widen
  // again (e.g. rotating a tablet, resizing a window).
  const isMobile = useMatchMedia(MOBILE_BREAKPOINT);
  const isDebugMode = debug?.isDebugMode ?? false;
  // Debug mode only has a diagram to show a run's path on — List has
  // no visual "which node lit up" concept, so it's not offered while
  // a run_id is active (same override precedence as the mobile force).
  const effectiveView: View = isDebugMode ? "canvas" : isMobile ? "list" : view;

  const choose = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  // Same "read in the useState initializer" rationale as `view` above
  // — this subtree never renders during SSR, so there's no hydration
  // mismatch to guard against. Defaults to open.
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem(VALIDATION_PANEL_STORAGE_KEY);
      if (saved === "true" || saved === "false") return saved === "true";
    } catch {
      // Private browsing / disabled storage — fall through to default.
    }
    return true;
  });

  // Painel "Testar fluxo" (simulador, PRD 05) — não persiste entre visitas.
  const [simOpen, setSimOpen] = useState(false);

  const setPanelOpenPersisted = (next: boolean) => {
    setPanelOpen(next);
    try {
      window.localStorage.setItem(VALIDATION_PANEL_STORAGE_KEY, String(next));
    } catch {
      // ignore
    }
  };

  return (
    <FlowEditorProvider initialFlow={initialFlow} initialNodes={initialNodes}>
      {focusNodeKey && <FocusNodeOnLoad nodeKey={focusNodeKey} />}
      <div className="flex h-full min-h-0 flex-col">
        {isDebugMode && debug && <DebugBanner debug={debug} />}

        <EditorHeader
          view={!isMobile && !isDebugMode ? { value: effectiveView, onChange: choose } : null}
          sim={!isMobile && !isDebugMode ? { open: simOpen, onToggle: () => setSimOpen((v) => !v) } : null}
          validation={{ open: panelOpen, onToggle: () => setPanelOpenPersisted(!panelOpen) }}
        />
        <EditorNotices />

        {/* ---- legenda dos tipos de nó (só telas largas, fora do debug) ---- */}
        {!isMobile && !isDebugMode && (
          <div className="hidden items-center px-6 pt-3 lg:flex">
            <NodeLegend />
          </div>
        )}

        {/* ---- stage (+ painel "Testar fluxo" ao lado, quando aberto) ---- */}
        <div className="mx-4 mt-3 flex min-h-0 flex-1 gap-3 md:mx-6">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[10px] border border-border bg-card-2">
            {effectiveView === "canvas" ? (
              <FlowCanvas debug={debug} />
            ) : (
              <div className="absolute inset-0 overflow-y-auto">
                <FlowBuilder />
              </div>
            )}
          </div>
          {simOpen && !isMobile && !isDebugMode && (
            <div className="flex min-h-0 animate-ddm-drawer">
              <FlowSimulatorPanel onClose={() => setSimOpen(false)} />
            </div>
          )}
        </div>

        {/* ---- validation / activate-readiness bar ---- */}
        {panelOpen ? (
          <div className="animate-ddm-up px-4 pb-5 pt-3 md:px-6">
            <ValidationPanel onClose={() => setPanelOpenPersisted(false)} />
          </div>
        ) : (
          <div className="pb-4" />
        )}
      </div>
    </FlowEditorProvider>
  );
}

/**
 * Tiny `useMatchMedia` shim. We could pull in `react-responsive` but
 * this is the only consumer and matchMedia is one of those browser
 * APIs that doesn't need a dependency.
 */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Safari < 14 still uses addListener; addEventListener is the
    // modern path. Both fire identically.
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

/**
 * Node-type legend — click a type to jump to its first node on the
 * canvas (or in the list). Reuses `requestFlash`, the same "jump to
 * node" mechanism the validation panel uses (see its header comment):
 * canvas pans + centers the card, list scrolls + flashes the row —
 * both views read the same `flashKey`, so this needs no per-view
 * pan/zoom logic of its own.
 *
 * Types with no matching node on the current flow are inert (no
 * onClick, default cursor) — there's nothing to jump to.
 */
// Destaca o nó de `?node=` uma vez ao abrir o editor, reaproveitando o
// mesmo sinal `requestFlash` do painel de validação (o canvas centraliza e
// pisca o card; a lista rola até a linha). O atraso deixa o canvas terminar
// o fitView inicial — sem ele, o fitView sobrescreve o setCenter.
const FOCUS_DELAY_MS = 600;

function FocusNodeOnLoad({ nodeKey }: { nodeKey: string }) {
  const { state, requestFlash } = useFlowEditor();
  const exists = state.nodes.some((n) => n.node_key === nodeKey);
  // Só uma vez por nodeKey: editar o fluxo depois não repete o destaque.
  const doneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!exists || doneRef.current === nodeKey) return;
    const timer = window.setTimeout(() => {
      doneRef.current = nodeKey;
      requestFlash(nodeKey);
    }, FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [exists, nodeKey, requestFlash]);
  return null;
}

function NodeLegend() {
  const { state, requestFlash } = useFlowEditor();
  return (
    <div className="ml-auto hidden flex-wrap items-center gap-x-3.5 gap-y-1.5 lg:flex">
      {LEGEND_TYPES.map((t) => {
        const match = state.nodes.find((n) => n.node_type === t);
        return (
          <button
            key={t}
            type="button"
            onClick={match ? () => requestFlash(match.node_key) : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground transition-colors",
              match ? "cursor-pointer hover:text-foreground" : "cursor-default"
            )}
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: nodeColors(t).solid }}
            />
            {NODE_META[t].label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "Modo debug" banner — shown instead of the mode row while a run_id
 * is active. Sits above `EditorHeader` (not instead of it) so
 * save/activate/back navigation keep working normally; only the
 * canvas itself goes readonly (see FlowCanvas's `debug` prop).
 */
function DebugBanner({ debug }: { debug: FlowDebugState }) {
  const contact = debug.runMeta?.contact;
  const contactLabel = contact?.name?.trim() || contact?.phone || "contato desconhecido";
  const startedAt = debug.runMeta?.started_at;
  return (
    <div className="flex animate-ddm-fade items-center gap-2.5 border-b border-primary bg-primary-soft px-6 py-2.5 text-[13px]">
      <Eye className="size-4 shrink-0 text-primary-text" />
      <span className="min-w-0 truncate text-foreground">
        {debug.loading
          ? "Modo debug — carregando execução…"
          : startedAt
            ? `Modo debug — Execução de ${contactLabel} iniciada em ${format(new Date(startedAt), "dd/MM/yyyy HH:mm")}`
            : "Modo debug — execução não encontrada"}
      </span>
      <button
        type="button"
        onClick={debug.exitDebugMode}
        className="ml-auto shrink-0 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-surface-hover"
      >
        Sair do debug
      </button>
    </div>
  );
}

