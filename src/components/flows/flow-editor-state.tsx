"use client";

import { apiFetch } from "@/lib/api-fetch";

/**
 * Single source of truth for the flow editor's state.
 *
 * Both views (list and canvas) read and mutate the same `BuilderState`
 * via `useFlowEditor()`. The provider mounts once inside
 * `FlowEditorShell`, so toggling views never resets unsaved edits.
 *
 * What lives here:
 *   - `BuilderState` shape (header fields, trigger config, nodes).
 *   - Dirty / saving / activating flags so the header save button
 *     and the beforeunload guard share the same source.
 *   - All mutations: name / description / trigger / fallback,
 *     addNode / updateNode / updateNodeConfig / updateNodePosition /
 *     removeNode, setEntryNodeId.
 *   - Side effects: save (PUT), setStatus (POST /activate),
 *     deleteFlow (DELETE then router.push).
 *   - Validation issues + the canActivate boolean.
 *   - Desfazer/refazer (src/lib/flows/history.ts): toda edição passa
 *     por `setState`, que registra o estado anterior; Ctrl/⌘+Z e
 *     Ctrl/⌘+Shift+Z (ou Ctrl+Y) fora de campos de texto.
 *
 * What does NOT live here:
 *   - List-view UI state (expanded card set, scroll refs,
 *     flash-on-jump) — those are list-only and stay in
 *     `flow-builder.tsx`.
 *   - Canvas-view UI state (selected node id, side-sheet open) —
 *     those are canvas-only and stay in `flow-canvas.tsx`.
 *
 * `removeNode` does NOT auto-clean inbound edges. The list-view's
 * NodeKeySelect dropdowns and the validator both surface dangling
 * `next_node_key` references; that visibility is enough for v1. PR 2b
 * (canvas delete via keyboard) will revisit if the canvas adds an
 * implicit-delete affordance that's easier to trip accidentally.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  validateFlowForActivation,
  type ValidationIssue,
} from "@/lib/flows/validate";
import { unlinkNodeReferences } from "@/lib/flows/edges";
import {
  createHistory,
  historyShortcut,
  recordEdit,
  redo as redoHistory,
  undo as undoHistory,
  type History,
} from "@/lib/flows/history";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";
import { NODE_META, slugify, type BuilderNode, type NodeType } from "./shared";

// ============================================================
// State shape
// ============================================================

export interface BuilderState {
  name: string;
  description: string;
  trigger_type: "keyword" | "first_inbound_message" | "manual" | "called_by_flow";
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
  status: FlowRow["status"];
  nodes: BuilderNode[];
}

export interface FlowEditorContextValue {
  /** Immutable post-load envelope: id, created_at, fallback_policy, etc. */
  flow: FlowRow;

  // Authored state
  state: BuilderState;
  /**
   * Dirty-tracking React setState. Flips `dirty` on every call. Used
   * by the list view's existing subcomponents (Header, TriggerPanel,
   * EntryPicker) which mutate multiple fields atomically — granular
   * setters below would force them to fan out the update.
   */
  setState: (
    updaterOrValue:
      | BuilderState
      | ((prev: BuilderState) => BuilderState),
  ) => void;
  dirty: boolean;
  saving: boolean;
  activating: boolean;
  issues: ValidationIssue[];
  canActivate: boolean;

  // Node mutations. addNode returns the generated key so the caller
  // (a NodeCard "Add" button or canvas "+" button) can scroll to /
  // focus / open the new node.
  addNode: (type: NodeType) => string;
  updateNode: (key: string, patch: Partial<BuilderNode>) => void;
  updateNodeConfig: (key: string, patch: Record<string, unknown>) => void;
  updateNodePosition: (key: string, x: number, y: number) => void;
  updateNodePositions: (
    positions: Record<string, { x: number; y: number }>,
  ) => void;
  removeNode: (key: string) => void;

  // Actions
  save: (opts?: { silent?: boolean }) => Promise<boolean>;
  setStatus: (status: BuilderState["status"]) => Promise<void>;
  deleteFlow: () => Promise<void>;

  /**
   * Transient "look here" signal. Set when the validation panel's
   * issue is clicked — both views subscribe: list scrolls the row
   * into view and flashes its border, canvas pans the viewport to
   * the node and flashes its card. Auto-clears after 1600ms so the
   * flash is a one-shot.
   *
   * Lives in context (not local view state) so the panel can be
   * rendered ONCE in the shell and trigger flashes in whichever
   * view is currently mounted, without per-view plumbing.
   */
  flashKey: string | null;
  requestFlash: (key: string) => void;

  /** Desfazer/refazer edições (o status do fluxo não entra no histórico). */
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

// ============================================================
// Helpers — node_key generation + per-type default configs
// ============================================================

export function uniqueNodeKey(base: string, existing: BuilderNode[]): string {
  if (!existing.some((n) => n.node_key === base)) return base;
  let i = 2;
  while (existing.some((n) => n.node_key === `${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

export function defaultConfigFor(type: NodeType): Record<string, unknown> {
  switch (type) {
    case "start":
      return { next_node_key: "" };
    case "send_message":
      return { text: "", next_node_key: "" };
    case "send_buttons":
      return {
        text: "",
        buttons: [{ reply_id: "yes", title: "Sim", next_node_key: "" }],
      };
    case "send_list":
      return {
        text: "",
        button_label: "Ver opções",
        sections: [
          {
            title: "",
            rows: [
              { reply_id: "row_1", title: "Opção 1", next_node_key: "" },
            ],
          },
        ],
      };
    case "send_media":
      return {
        media_type: "image",
        media_url: "",
        caption: "",
        filename: "",
        next_node_key: "",
      };
    case "collect_input":
      return {
        prompt_text: "",
        var_key: "answer",
        next_node_key: "",
      };
    case "condition":
      return {
        subject: "var",
        subject_key: "",
        operator: "equals",
        value: "",
        true_next: "",
        false_next: "",
      };
    case "switch":
      return {
        branches: [
          {
            id: crypto.randomUUID(),
            label: "Ramo 1",
            combinator: "and",
            conditions: [
              { subject: "var", subject_key: "", operator: "equals", value: "" },
            ],
            next_node_key: "",
          },
        ],
        default_next: "",
      };
    case "set_tag":
      return { mode: "add", tag_id: "", next_node_key: "" };
    case "handoff":
      return { note: "" };
    case "handoff_agent":
      return { note: "" };
    case "handoff_team":
      return { note: "" };
    case "end":
      return {};
    case "http_fetch":
      return {
        url: "",
        method: "GET",
        headers: {},
        body_template: "",
        response_var: "",
        timeout_seconds: 10,
        next_node_key: "",
      };
    case "set_variable":
      return {
        assignments: [{ variable: "", value: "" }],
        next_node_key: "",
      };
    case "smart_delay":
      return { delay_seconds: 60, message: "", next_node_key: "" };
    case "anchor":
      return { label: "", next_node_key: "" };
    case "go_to":
      return { target_node_key: "" };
    case "go_to_flow":
      return { flow_id: "", pass_vars: true };
    case "send_template":
      return {
        template_name: "",
        language_code: "pt_BR",
        fallback_text: "",
        next_node_key: "",
      };
    case "add_note":
      return { note_text: "", next_node_key: "" };
    case "receive_attachment":
      return { prompt_text: "", var_name: "anexo", next_node_key: "" };
    case "ai_agent":
      return {
        mode: "once",
        system_prompt_override: "",
        next_node_key: "",
        max_turns: 20,
      };
    case "send_webchat":
      return {
        message_text: "Vamos continuar pelo nosso chat? É rapidinho.",
        button_text: "Abrir chat",
        next_node_key: "",
      };
  }
}

export function applyNodePositions(
  nodes: BuilderNode[],
  positions: Record<string, { x: number; y: number }>,
): BuilderNode[] {
  return nodes.map((n) => {
    const next = positions[n.node_key];
    return next
      ? {
          ...n,
          position_x: Math.round(next.x),
          position_y: Math.round(next.y),
        }
      : n;
  });
}

// ============================================================
// Context
// ============================================================

const FlowEditorCtx = createContext<FlowEditorContextValue | null>(null);

export function useFlowEditor(): FlowEditorContextValue {
  const ctx = useContext(FlowEditorCtx);
  if (!ctx) {
    throw new Error(
      "useFlowEditor must be called inside <FlowEditorProvider>",
    );
  }
  return ctx;
}

// ============================================================
// Provider
// ============================================================

interface ProviderProps {
  initialFlow: FlowRow;
  initialNodes: FlowNodeRow[];
  children: ReactNode;
}

export function FlowEditorProvider({
  initialFlow,
  initialNodes,
  children,
}: ProviderProps) {
  const router = useRouter();

  const [state, setStateRaw] = useState<BuilderState>(() => ({
    name: initialFlow.name,
    description: initialFlow.description ?? "",
    trigger_type: initialFlow.trigger_type,
    trigger_config: initialFlow.trigger_config as Record<string, unknown>,
    entry_node_id: initialFlow.entry_node_id,
    status: initialFlow.status,
    nodes: initialNodes.map((n) => ({
      node_key: n.node_key,
      node_type: n.node_type as NodeType,
      config: n.config as Record<string, unknown>,
      position_x: n.position_x,
      position_y: n.position_y,
    })),
  }));

  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  // dirty flips on user edits; status-only updates (after the activate
  // API succeeds) use setStateRaw so they don't falsely re-flag the
  // form as dirty.
  const [dirty, setDirty] = useState(false);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const revisionRef = useRef(0);
  // Histórico em ref (não re-renderiza a cada tecla); `historyTick` só
  // atualiza os botões Desfazer/Refazer.
  const historyRef = useRef<History<BuilderState>>(createHistory());
  const [historyTick, setHistoryTick] = useState(0);
  const setState = useCallback<typeof setStateRaw>((updaterOrValue) => {
    const prev = latestStateRef.current;
    const next = typeof updaterOrValue === "function" ? updaterOrValue(prev) : updaterOrValue;
    if (next === prev) return;
    historyRef.current = recordEdit(historyRef.current, prev, Date.now());
    setHistoryTick((t) => t + 1);
    latestStateRef.current = next;
    revisionRef.current += 1;
    setDirty(true);
    setStateRaw(next);
  }, []);

  // Restaura um estado do histórico mantendo o status atual (ativar/pausar
  // é ação de servidor, não edição). Conta como edição para salvar/publicar.
  const applyHistory = useCallback((direction: "undo" | "redo") => {
    const current = latestStateRef.current;
    const step =
      direction === "undo"
        ? undoHistory(historyRef.current, current)
        : redoHistory(historyRef.current, current);
    if (!step) return;
    historyRef.current = step.history;
    const next = { ...step.state, status: current.status };
    latestStateRef.current = next;
    revisionRef.current += 1;
    setDirty(true);
    setStateRaw(next);
    setHistoryTick((t) => t + 1);
  }, []);
  const undo = useCallback(() => applyHistory("undo"), [applyHistory]);
  const redo = useCallback(() => applyHistory("redo"), [applyHistory]);
  const canUndo = historyTick >= 0 && historyRef.current.past.length > 0;
  const canRedo = historyTick >= 0 && historyRef.current.future.length > 0;

  // Atalhos. Dentro de campo de texto fica o desfazer nativo do navegador
  // (desfaz a digitação daquele campo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = historyShortcut(e);
      if (!action) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      applyHistory(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyHistory]);

  // Cross-view "look here" signal (see FlowEditorContextValue docs).
  // Tracked via a ref alongside state so a rapid second click on a
  // different issue cancels the previous timeout instead of letting
  // the first flash linger past the new one.
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const requestFlash = useCallback((key: string) => {
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }
    setFlashKey(key);
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashKey(null);
      flashTimeoutRef.current = null;
    }, 1600);
  }, []);
  useEffect(
    () => () => {
      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current);
      }
    },
    [],
  );

  // Browser-level reload / tab-close / external-link guard. Fires a
  // best-effort save instead of blocking with a confirm prompt —
  // `keepalive` tells the browser to finish the request even after the
  // page is gone. SPA navigation (sidebar links, back button) isn't
  // covered here — Next's App Router doesn't fire beforeunload on
  // client-side route changes — but the 2s debounce autosave below
  // means there's rarely more than a couple seconds of edits at risk,
  // and the editor's own nav actions (see header.tsx) save explicitly
  // before navigating.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, state, initialFlow.id]);

  // ---- Validation ----
  const issues = useMemo<ValidationIssue[]>(
    () =>
      validateFlowForActivation(
        {
          name: state.name,
          trigger_type: state.trigger_type,
          trigger_config: state.trigger_config,
          entry_node_id: state.entry_node_id,
        },
        state.nodes,
      ),
    [state],
  );
  const canActivate = useMemo(
    () => issues.every((i) => i.severity !== "error"),
    [issues],
  );

  // ---- Save (PUT) ----
  // `silent` skips the success toast — used by the debounce autosave so
  // it doesn't pop a toast on every 2s tick while the user keeps typing.
  const isSavingRef = useRef(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const save = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (savePromiseRef.current) {
        if (!await savePromiseRef.current) return false;
        return save(opts);
      }
      const snapshot = latestStateRef.current;
      const revision = revisionRef.current;
      // Fluxo ativo: salvar = publicar para clientes reais. Com erro de
      // validação não publica (a API também recusa — PRD-01).
      if (snapshot.status === "active") {
        const blockers = validateFlowForActivation(
          {
            name: snapshot.name,
            trigger_type: snapshot.trigger_type,
            trigger_config: snapshot.trigger_config,
            entry_node_id: snapshot.entry_node_id,
          },
          snapshot.nodes,
        ).filter((i) => i.severity === "error");
        if (blockers.length > 0) {
          toast.error(`Fluxo ativo: corrija ${blockers.length} erro(s) antes de publicar as alterações.`);
          return false;
        }
      }
      isSavingRef.current = true;
      setSaving(true);
      const operation = (async () => {
      try {
        const res = await apiFetch(`/api/flows/${initialFlow.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: snapshot.name,
            description: snapshot.description || null,
            trigger_type: snapshot.trigger_type,
            trigger_config: snapshot.trigger_config,
            entry_node_id: snapshot.entry_node_id,
            nodes: snapshot.nodes,
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? `Falha ao salvar: ${res.status}`);
        }
        if (revision === revisionRef.current) setDirty(false);
        if (!opts?.silent) toast.success(snapshot.status === "active" ? "Alterações publicadas." : "Salvo.");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Falha ao salvar";
        toast.error(msg);
        return false;
      } finally {
        setSaving(false);
        isSavingRef.current = false;
        savePromiseRef.current = null;
      }
      })();
      savePromiseRef.current = operation;
      const success = await operation;
      if (success && revision !== revisionRef.current) return save(opts);
      return success;
    },
    [initialFlow.id, state],
  );

  // Protect internal links, including the dashboard sidebar, before unmount.
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || url.href === window.location.href) return;
      event.preventDefault();
      event.stopPropagation();
      const href = url.pathname + url.search + url.hash;
      // Fluxo ativo não publica ao sair: só com "Publicar alterações".
      if (latestStateRef.current.status === "active") {
        if (window.confirm("Este fluxo está ativo e tem alterações não publicadas. Sair sem publicar?")) {
          router.push(href);
        }
        return;
      }
      void save({ silent: true }).then(ok => { if (ok) router.push(href); });
    };
    document.addEventListener("click", protect, true);
    return () => document.removeEventListener("click", protect, true);
  }, [dirty, save, router]);

  // ---- Debounced autosave ----
  // `save`'s identity changes on every edit (it closes over `state`),
  // so depending on it here doubles as "reset the timer on every
  // change" — no separate change-tracking needed. Clears itself once
  // `dirty` flips back to false after a successful save.
  useEffect(() => {
    // Autosave só em rascunho: num fluxo ativo cada salvamento entra no ar
    // para clientes reais, então lá é o botão "Publicar alterações".
    if (!dirty || state.status === "active") return;
    const timeout = window.setTimeout(() => {
      void save({ silent: true });
    }, 2000);
    return () => window.clearTimeout(timeout);
  }, [dirty, save, state.status]);

  // ---- Activate / Pause / Archive ----
  const setStatus = useCallback(
    async (next: BuilderState["status"]) => {
      if (next === "active" && !canActivate) {
        toast.error("Corrija os problemas abaixo antes de ativar.");
        return;
      }
      // Status anterior capturado antes da troca: pausar um fluxo ativo
      // (active → draft) merece um aviso próprio, não "rascunho".
      const prevStatus = latestStateRef.current.status;
      setActivating(true);
      try {
        // Always save first so the activation validator sees the
        // latest state — the user shouldn't have to remember "save
        // then activate".
        if (next === "active") {
          if (!await save()) return;
        }
        const res = await apiFetch(`/api/flows/${initialFlow.id}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? `Falha ao atualizar status: ${res.status}`);
        }
        setStateRaw((s) => ({ ...s, status: next }));
        toast.success(
          next === "active"
            ? "Fluxo ativado."
            : next === "archived"
              ? "Arquivado."
              : prevStatus === "active"
                ? "Fluxo pausado — não dispara mais."
                : "Salvo como rascunho.",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Falha ao atualizar status";
        toast.error(msg);
      } finally {
        setActivating(false);
      }
    },
    [canActivate, save, initialFlow.id],
  );

  // ---- Delete ----
  const deleteFlow = useCallback(async () => {
    const yes = window.confirm(
      `Excluir "${state.name}"? Todas as execuções ativas serão encerradas imediatamente. Essa ação não pode ser desfeita.`,
    );
    if (!yes) return;
    try {
      const res = await apiFetch(`/api/flows/${initialFlow.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Falha ao excluir: ${res.status}`);
      router.push("/flows");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao excluir";
      toast.error(msg);
    }
  }, [initialFlow.id, router, state.name]);

  // ---- Node mutations ----
  const updateNode = useCallback(
    (key: string, patch: Partial<BuilderNode>) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key ? { ...n, ...patch } : n,
        ),
      }));
    },
    [setState],
  );

  const updateNodeConfig = useCallback(
    (key: string, configPatch: Record<string, unknown>) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key
            ? { ...n, config: { ...n.config, ...configPatch } }
            : n,
        ),
      }));
    },
    [setState],
  );

  const updateNodePosition = useCallback(
    (key: string, x: number, y: number) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key
            ? { ...n, position_x: Math.round(x), position_y: Math.round(y) }
            : n,
        ),
      }));
    },
    [setState],
  );

  const updateNodePositions = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      // Initial Dagre layout hydration should not dirty the editor:
      // opening a legacy all-zero flow must not enable Save or arm
      // beforeunload before the user actually edits anything.
      setStateRaw((s) => ({
        ...s,
        nodes: applyNodePositions(s.nodes, positions),
      }));
    },
    [],
  );

  const addNode = useCallback(
    (type: NodeType): string => {
      const meta = NODE_META[type];
      const base = slugify(meta.label, type);
      let createdKey = base;
      setState((s) => {
        const node_key = uniqueNodeKey(base, s.nodes);
        createdKey = node_key;
        const next: BuilderNode = {
          node_key,
          node_type: type,
          config: defaultConfigFor(type),
        };
        return {
          ...s,
          nodes: [...s.nodes, next],
          // If this is the first node and it's a start, pick it as
          // the entry automatically. Saves a click.
          entry_node_id:
            s.entry_node_id ??
            (type === "start" ? node_key : s.entry_node_id ?? null),
        };
      });
      return createdKey;
    },
    [setState],
  );

  const removeNode = useCallback(
    (key: string) => {
      // Auto-unlink inbound references so canvas / list deletes don't
      // leave dangling arrows behind that the validator would flag.
      // Cleared refs become "" (the "no target picked" sentinel the
      // builder forms already use).
      setState((s) => ({
        ...s,
        nodes: unlinkNodeReferences(
          s.nodes.filter((n) => n.node_key !== key),
          key,
        ),
        entry_node_id: s.entry_node_id === key ? null : s.entry_node_id,
      }));
    },
    [setState],
  );

  const value = useMemo<FlowEditorContextValue>(
    () => ({
      flow: initialFlow,
      state,
      setState,
      dirty,
      saving,
      activating,
      issues,
      canActivate,
      addNode,
      updateNode,
      updateNodeConfig,
      updateNodePosition,
      updateNodePositions,
      removeNode,
      save,
      setStatus,
      deleteFlow,
      flashKey,
      requestFlash,
      undo,
      redo,
      canUndo,
      canRedo,
    }),
    [
      initialFlow,
      state,
      setState,
      dirty,
      saving,
      activating,
      issues,
      canActivate,
      addNode,
      updateNode,
      updateNodeConfig,
      updateNodePosition,
      updateNodePositions,
      removeNode,
      save,
      setStatus,
      deleteFlow,
      flashKey,
      requestFlash,
      undo,
      redo,
      canUndo,
      canRedo,
    ],
  );

  return <FlowEditorCtx.Provider value={value}>{children}</FlowEditorCtx.Provider>;
}
