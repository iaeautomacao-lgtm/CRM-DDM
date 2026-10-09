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
 * `removeNode` desliga as setas que chegavam no nó (unlinkNodeReferences);
 * `renameNodeKey` troca a chave e reaponta essas setas.
 *
 * Não perder trabalho (PRD 03, P-2):
 *   - rascunho local (src/lib/flows/local-draft.ts): toda edição não salva
 *     vai para o localStorage; ao reabrir, `draftOffer` oferece recuperar;
 *   - voltar/avançar do navegador: entrada-sentinela no histórico +
 *     `popstate` (além do beforeunload e da proteção de links);
 *   - `saveError` / `conflict` alimentam o indicador do cabeçalho e o aviso
 *     de conflito com "Recarregar versão do servidor".
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
import { replaceNodeReferences, unlinkNodeReferences } from "@/lib/flows/edges";
import {
  createHistory,
  historyShortcut,
  recordEdit,
  redo as redoHistory,
  undo as undoHistory,
  type History,
} from "@/lib/flows/history";
import {
  FLOW_DRAFT_DEBOUNCE_MS,
  clearFlowDraft,
  decideDraftOffer,
  getBrowserDraftStorage,
  readFlowDraft,
  writeFlowDraft,
} from "@/lib/flows/local-draft";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";
import { NODE_META, slugify, type BuilderNode, type NodeType } from "./shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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

/** O que vai para o rascunho local: tudo menos o status (ação de servidor). */
export type DraftContent = Omit<BuilderState, "status">;

export function toDraftContent(state: BuilderState): DraftContent {
  return {
    name: state.name,
    description: state.description,
    trigger_type: state.trigger_type,
    trigger_config: state.trigger_config,
    entry_node_id: state.entry_node_id,
    nodes: state.nodes,
  };
}

const TRIGGER_TYPES: ReadonlyArray<BuilderState["trigger_type"]> = [
  "keyword",
  "first_inbound_message",
  "manual",
  "called_by_flow",
];

/** Confere a forma do rascunho lido do navegador antes de aplicar. */
export function isDraftContent(value: unknown): value is DraftContent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    TRIGGER_TYPES.includes(v.trigger_type as BuilderState["trigger_type"]) &&
    !!v.trigger_config &&
    typeof v.trigger_config === "object" &&
    (v.entry_node_id === null || typeof v.entry_node_id === "string") &&
    Array.isArray(v.nodes) &&
    v.nodes.every(
      (n) =>
        !!n &&
        typeof n === "object" &&
        typeof (n as BuilderNode).node_key === "string" &&
        typeof (n as BuilderNode).node_type === "string" &&
        !!(n as BuilderNode).config &&
        typeof (n as BuilderNode).config === "object",
    )
  );
}

export function buildInitialState(flow: FlowRow, nodes: FlowNodeRow[]): BuilderState {
  return {
    name: flow.name,
    description: flow.description ?? "",
    trigger_type: flow.trigger_type,
    trigger_config: flow.trigger_config as Record<string, unknown>,
    entry_node_id: flow.entry_node_id,
    status: flow.status,
    nodes: nodes.map((n) => ({
      node_key: n.node_key,
      node_type: n.node_type as NodeType,
      config: n.config as Record<string, unknown>,
      position_x: n.position_x,
      position_y: n.position_y,
    })),
  };
}

/** Pedido de confirmação do editor (renderizado como AlertDialog pelo provider). */
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
}

/** Rascunho local oferecido ao abrir o editor. */
export interface DraftOffer {
  content: DraftContent;
  savedAt: number;
  /** Feito sobre uma versão do servidor que já mudou (outra aba/usuário). */
  basedOnOlderVersion: boolean;
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
  /** Copia o nó (mesma configuração e saídas) ao lado do original. */
  duplicateNode: (key: string) => string | null;
  /** Troca a chave do nó e reaponta as setas. false = chave inválida/repetida. */
  renameNodeKey: (oldKey: string, newKey: string) => boolean;
  /** Posições de vários nós numa edição só (arrastar seleção múltipla). */
  moveNodes: (positions: Record<string, { x: number; y: number }>) => void;

  // Actions
  save: (opts?: { silent?: boolean; confirmOrphanRuns?: boolean }) => Promise<boolean>;
  /** Última falha de salvamento (null depois de salvar com sucesso). */
  saveError: string | null;
  /** O servidor recusou por conflito: outra aba/usuário salvou antes. */
  conflict: boolean;
  /** Recarrega a página com a versão do servidor (rascunho local fica guardado). */
  reloadFromServer: () => void;
  /**
   * Antes de sair do editor: salva (rascunho) ou pede confirmação (fluxo
   * ativo / falha ao salvar). true = pode navegar.
   */
  confirmLeave: () => Promise<boolean>;
  /** Abre o diálogo de confirmação do editor; true = confirmou. */
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
  /** Rascunho local mais novo que o servidor, aguardando Recuperar/Descartar. */
  draftOffer: DraftOffer | null;
  recoverDraft: () => void;
  discardDraft: () => void;
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
  /**
   * Muda a cada desfazer/refazer. Formulários com rascunho local
   * (palavras-chave, cabeçalhos JSON, unidade do Aguardar) usam como
   * `key` para recarregar o valor restaurado.
   */
  historyEpoch: number;
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
      return { reason_code: "INDEFINIDO", note: "" };
    case "handoff_agent":
      return { reason_code: "INDEFINIDO", note: "" };
    case "handoff_team":
      return { reason_code: "INDEFINIDO", note: "" };
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
        model: null,
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

/** Marca da entrada-sentinela no histórico (guarda do voltar/avançar). */
const FLOW_GUARD_STATE_KEY = "__wacrmFlowEditorGuard";

function isFlowGuardState(historyState: unknown, flowId: string): boolean {
  return (
    !!historyState &&
    typeof historyState === "object" &&
    (historyState as Record<string, unknown>)[FLOW_GUARD_STATE_KEY] === flowId
  );
}

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

  // Confirmação por diálogo (substitui window.confirm): devolve uma Promise
  // para que guardas assíncronas (sair, publicar, excluir) sigam iguais.
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const settleConfirm = useCallback((ok: boolean) => {
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmRequest(null);
    resolve?.(ok);
  }, []);
  const askConfirm = useCallback((request: ConfirmRequest): Promise<boolean> => {
    // Pedido novo com outro aberto: o anterior conta como "não".
    confirmResolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmRequest(request);
    });
  }, []);

  const [state, setStateRaw] = useState<BuilderState>(() =>
    buildInitialState(initialFlow, initialNodes),
  );

  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  // dirty flips on user edits; status-only updates (after the activate
  // API succeeds) use setStateRaw so they don't falsely re-flag the
  // form as dirty.
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const revisionRef = useRef(0);
  // Revisão confirmada pelo servidor no último salvamento com sucesso:
  // igual a `revisionRef` = nada a guardar no rascunho local.
  const savedRevisionRef = useRef(0);
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
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const undo = useCallback(() => {
    applyHistory("undo");
    setHistoryEpoch((e) => e + 1);
  }, [applyHistory]);
  const redo = useCallback(() => {
    applyHistory("redo");
    setHistoryEpoch((e) => e + 1);
  }, [applyHistory]);
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
      setHistoryEpoch((n) => n + 1);
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

  // Browser-level reload / tab-close / external-link guard: native
  // "leave site?" prompt while dirty. SPA navigation isn't covered here
  // (Next's App Router doesn't fire beforeunload on client-side route
  // changes) — internal links and the browser back/forward button are
  // guarded further down (`confirmLeave`), and every unsaved edit is
  // also kept in the local draft.
  // "Recarregar versão do servidor" já guardou o rascunho: sem prompt.
  const skipUnloadPromptRef = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      if (skipUnloadPromptRef.current) return;
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
  // Versão do fluxo no servidor que este editor conhece (conflito de abas).
  const versionRef = useRef<string>(initialFlow.updated_at);
  const conflictRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- Rascunho local (localStorage) ----
  // Grava o estado atual se houver edição ainda não confirmada pelo
  // servidor. Chamado com debounce a cada mudança, no pagehide, ao
  // desmontar e antes de recarregar por conflito.
  const flowId = initialFlow.id;
  const writeDraftNow = useCallback(() => {
    if (revisionRef.current === savedRevisionRef.current) return;
    writeFlowDraft(getBrowserDraftStorage(), {
      v: 1,
      flowId,
      baseVersion: versionRef.current,
      savedAt: Date.now(),
      conflict: conflictRef.current,
      state: toDraftContent(latestStateRef.current),
    });
  }, [flowId]);

  // Decisão pura no inicializador (esta subárvore só monta no cliente,
  // ver FlowEditorShell); a limpeza de rascunho vencido/igual fica no efeito.
  const [draftOffer, setDraftOffer] = useState<DraftOffer | null>(() => {
    const draft = readFlowDraft(getBrowserDraftStorage(), initialFlow.id, isDraftContent);
    const decision = decideDraftOffer({
      draft,
      serverVersion: initialFlow.updated_at,
      serverState: toDraftContent(buildInitialState(initialFlow, initialNodes)),
      now: Date.now(),
    });
    return decision.offer && draft
      ? { content: draft.state, savedAt: draft.savedAt, basedOnOlderVersion: decision.basedOnOlderVersion }
      : null;
  });
  useEffect(() => {
    // Rascunho vencido ou igual ao servidor não serve mais: limpa.
    const storage = getBrowserDraftStorage();
    const draft = readFlowDraft(storage, flowId, isDraftContent);
    if (!draft) return;
    const decision = decideDraftOffer({
      draft,
      serverVersion: initialFlow.updated_at,
      serverState: toDraftContent(buildInitialState(initialFlow, initialNodes)),
      now: Date.now(),
    });
    if (decision.reason === "expired" || decision.reason === "identical") {
      clearFlowDraft(storage, flowId);
    }
    // Só na abertura do editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const timeout = window.setTimeout(writeDraftNow, FLOW_DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [dirty, state, writeDraftNow]);

  useEffect(() => {
    if (!dirty) return;
    window.addEventListener("pagehide", writeDraftNow);
    return () => window.removeEventListener("pagehide", writeDraftNow);
  }, [dirty, writeDraftNow]);

  // Saída por navegação interna (SPA) não dispara pagehide.
  useEffect(() => () => writeDraftNow(), [writeDraftNow]);
  // Usuário aceitou publicar com clientes em nós removidos (ver PUT).
  const orphanConfirmRef = useRef(false);
  const isSavingRef = useRef(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const save = useCallback(
    async (opts?: { silent?: boolean; confirmOrphanRuns?: boolean }): Promise<boolean> => {
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
            expected_updated_at: versionRef.current,
            confirm_orphan_runs: opts?.confirmOrphanRuns ?? false,
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          if (res.status === 409 && json.code === "orphan_runs") {
            // Confirmação explícita; "sim" reenvia já confirmado.
            if (
              await askConfirm({
                title: "Publicar mesmo assim?",
                message: `${json.error}

Publicar mesmo assim?`,
                confirmLabel: "Publicar",
              })
            ) {
              orphanConfirmRef.current = true;
            } else {
              toast.info("Alterações não publicadas.");
            }
            return false;
          }
          if (res.status === 409 && json.code === "conflict") {
            conflictRef.current = true;
            setConflict(true);
            // Guarda já o trabalho local marcado como conflito, para
            // continuar recuperável depois de recarregar.
            writeDraftNow();
            // O aviso com "Recarregar versão do servidor" fica no editor
            // (editor-notices.tsx); o toast só chama a atenção.
            toast.error(json.error, { id: "flow-conflict", duration: 8000 });
            return false;
          }
          throw new Error(json.error ?? `Falha ao salvar: ${res.status}`);
        }
        const saved = (await res.json().catch(() => null)) as { flow?: { updated_at?: string } } | null;
        if (saved?.flow?.updated_at) versionRef.current = saved.flow.updated_at;
        savedRevisionRef.current = revision;
        setSaveError(null);
        if (revision === revisionRef.current) {
          setDirty(false);
          clearFlowDraft(getBrowserDraftStorage(), initialFlow.id);
        }
        if (!opts?.silent) toast.success(snapshot.status === "active" ? "Alterações publicadas." : "Salvo.");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Falha ao salvar";
        setSaveError(msg);
        toast.error(msg, { id: "flow-save-error" });
        return false;
      } finally {
        setSaving(false);
        isSavingRef.current = false;
        savePromiseRef.current = null;
      }
      })();
      savePromiseRef.current = operation;
      const success = await operation;
      if (orphanConfirmRef.current) {
        orphanConfirmRef.current = false;
        return save({ ...opts, confirmOrphanRuns: true });
      }
      if (success && revision !== revisionRef.current) return save(opts);
      return success;
    },
    [initialFlow.id, state, writeDraftNow, askConfirm],
  );

  const reloadFromServer = useCallback(() => {
    writeDraftNow();
    skipUnloadPromptRef.current = true;
    window.location.reload();
  }, [writeDraftNow]);

  // Antes de sair do editor com edições pendentes. Fluxo ativo não publica
  // ao sair (só com "Publicar alterações"); rascunho tenta salvar e, se não
  // der (erro, conflito), pergunta. Em todos os casos o trabalho fica no
  // rascunho local.
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    writeDraftNow();
    if (latestStateRef.current.status === "active") {
      return askConfirm({
        title: "Sair sem publicar?",
        message:
          "Este fluxo está ativo e tem alterações não publicadas. Sair sem publicar?\n\nAs alterações ficam guardadas neste navegador para recuperar depois.",
        confirmLabel: "Sair",
      });
    }
    if (!conflictRef.current && (await save({ silent: true }))) return true;
    return askConfirm({
      title: "Sair mesmo assim?",
      message:
        "Não foi possível salvar as alterações deste fluxo. Sair mesmo assim?\n\nElas ficam guardadas neste navegador e podem ser recuperadas ao reabrir o fluxo.",
      confirmLabel: "Sair",
    });
  }, [save, writeDraftNow, askConfirm]);

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
      void confirmLeave().then((ok) => { if (ok) router.push(href); });
    };
    document.addEventListener("click", protect, true);
    return () => document.removeEventListener("click", protect, true);
  }, [dirty, confirmLeave, router]);

  // ---- Voltar/avançar do navegador ----
  // O App Router não dispara beforeunload no voltar. Com edição pendente,
  // empilha uma entrada-sentinela (mesma URL; o pushState do Next copia o
  // estado interno dele). O "voltar" sai da sentinela para a entrada
  // original — mesma página, nada desmonta — e aqui decidimos: salvar ou
  // confirmar e seguir voltando, ou reempilhar a sentinela e ficar.
  const guardActiveRef = useRef(false);
  useEffect(() => {
    // Reaberto numa sentinela (voltou de outra página até ela).
    if (isFlowGuardState(window.history.state, flowId)) guardActiveRef.current = true;
  }, [flowId]);
  useEffect(() => {
    if (!dirty || guardActiveRef.current) return;
    window.history.pushState({ [FLOW_GUARD_STATE_KEY]: flowId }, "");
    guardActiveRef.current = true;
  }, [dirty, flowId]);
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (!guardActiveRef.current) return;
      // Avançou de volta para a sentinela: nada a fazer.
      if (isFlowGuardState(event.state, flowId)) return;
      guardActiveRef.current = false;
      void confirmLeave().then((ok) => {
        if (ok) {
          window.history.back();
          return;
        }
        window.history.pushState({ [FLOW_GUARD_STATE_KEY]: flowId }, "");
        guardActiveRef.current = true;
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [confirmLeave, flowId]);

  // ---- Recuperar / descartar o rascunho local ----
  const recoverDraft = useCallback(() => {
    const offer = draftOffer;
    if (!offer) return;
    // Pelo setState: entra no histórico (Ctrl+Z desfaz a recuperação) e
    // marca como sujo, então o autosave (fluxo em rascunho) salva sozinho.
    setState((s) => ({ ...offer.content, status: s.status }));
    setHistoryEpoch((e) => e + 1);
    setDraftOffer(null);
    toast.success(
      latestStateRef.current.status === "active"
        ? "Alterações recuperadas. Use \"Publicar alterações\" para colocá-las no ar."
        : "Alterações recuperadas.",
    );
  }, [draftOffer, setState]);

  const discardDraft = useCallback(() => {
    setDraftOffer(null);
    // Edições novas desta sessão (se houver) voltam a ser gravadas no
    // próximo debounce.
    clearFlowDraft(getBrowserDraftStorage(), flowId);
  }, [flowId]);

  // ---- Debounced autosave ----
  // `save`'s identity changes on every edit (it closes over `state`),
  // so depending on it here doubles as "reset the timer on every
  // change" — no separate change-tracking needed. Clears itself once
  // `dirty` flips back to false after a successful save.
  useEffect(() => {
    // Autosave só em rascunho: num fluxo ativo cada salvamento entra no ar
    // para clientes reais, então lá é o botão "Publicar alterações".
    // Conflito com outra aba: não fica tentando sobrescrever a cada edição.
    if (!dirty || state.status === "active" || conflict) return;
    const timeout = window.setTimeout(() => {
      void save({ silent: true });
    }, 2000);
    return () => window.clearTimeout(timeout);
  }, [dirty, save, state.status, conflict]);

  // Ctrl/⌘+S = Salvar / Publicar alterações (antes abria o "salvar
  // página" do navegador).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

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
        // Ativar/pausar também muda updated_at no servidor.
        const activated = (await res.json().catch(() => null)) as { flow?: { updated_at?: string } } | null;
        if (activated?.flow?.updated_at) versionRef.current = activated.flow.updated_at;
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
    const yes = await askConfirm({
      title: "Excluir fluxo",
      message: `Excluir "${state.name}"? Todas as execuções ativas serão encerradas imediatamente. Essa ação não pode ser desfeita.`,
      confirmLabel: "Excluir",
    });
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
  }, [initialFlow.id, router, state.name, askConfirm]);

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

  const renameNodeKey = useCallback(
    (oldKey: string, rawKey: string): boolean => {
      const newKey = slugify(rawKey, oldKey);
      if (!newKey || newKey === oldKey) return newKey === oldKey;
      if (latestStateRef.current.nodes.some((n) => n.node_key === newKey)) {
        toast.error(`Já existe um nó com a chave "${newKey}".`);
        return false;
      }
      setState((s) => ({
        ...s,
        nodes: replaceNodeReferences(
          s.nodes.map((n) => (n.node_key === oldKey ? { ...n, node_key: newKey } : n)),
          oldKey,
          newKey,
        ),
        entry_node_id: s.entry_node_id === oldKey ? newKey : s.entry_node_id,
      }));
      return true;
    },
    [setState],
  );

  const moveNodes = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      setState((s) => ({ ...s, nodes: applyNodePositions(s.nodes, positions) }));
    },
    [setState],
  );

  const duplicateNode = useCallback(
    (key: string): string | null => {
      const source = latestStateRef.current.nodes.find((n) => n.node_key === key);
      if (!source || source.node_type === "start") return null;
      const node_key = uniqueNodeKey(`${key}_copia`, latestStateRef.current.nodes);
      setState((s) => ({
        ...s,
        nodes: [
          ...s.nodes,
          {
            ...source,
            node_key,
            config: structuredClone(source.config),
            position_x: (source.position_x ?? 0) + 40,
            position_y: (source.position_y ?? 0) + 120,
          },
        ],
      }));
      return node_key;
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
      duplicateNode,
      renameNodeKey,
      moveNodes,
      save,
      saveError,
      conflict,
      reloadFromServer,
      confirmLeave,
      askConfirm,
      draftOffer,
      recoverDraft,
      discardDraft,
      setStatus,
      deleteFlow,
      flashKey,
      requestFlash,
      undo,
      redo,
      canUndo,
      canRedo,
      historyEpoch,
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
      duplicateNode,
      renameNodeKey,
      moveNodes,
      save,
      saveError,
      conflict,
      reloadFromServer,
      confirmLeave,
      askConfirm,
      draftOffer,
      recoverDraft,
      discardDraft,
      setStatus,
      deleteFlow,
      flashKey,
      requestFlash,
      undo,
      redo,
      canUndo,
      canRedo,
      historyEpoch,
    ],
  );

  return (
    <FlowEditorCtx.Provider value={value}>
      {children}
      <AlertDialog
        open={confirmRequest !== null}
        onOpenChange={(open) => {
          // Adiado: se o clique em "confirmar" fechou o diálogo, a resposta
          // "sim" já foi dada e este "não" não tem mais efeito.
          if (!open) queueMicrotask(() => settleConfirm(false));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmRequest?.title}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">{confirmRequest?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => settleConfirm(true)}>
              {confirmRequest?.confirmLabel ?? "Confirmar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FlowEditorCtx.Provider>
  );
}
