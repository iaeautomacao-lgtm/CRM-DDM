"use client";

import { apiFetch } from "@/lib/api-fetch";

import { createElement, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  CircleCheck,
  CircleAlert,
  Clock,
  UserPlus,
  PlayCircle,
  PauseCircle,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Timer,
  MinusCircle,
  CheckCircle,
  CheckCircle2,
  XCircle,
  MessageCircle,
  MessageSquare,
  Play,
  Circle,
  GitBranch,
  Trash2,
  Wrench,
  Bot,
  Search,
} from "lucide-react";
import { NODE_META, type NodeType } from "@/components/flows/shared";
import {
  describeEvent,
  EVENT_LABEL,
  isRoutineEvent,
  summarizeRun,
  distinctFailures,
  humanizeError,
} from "@/lib/flows/run-log";
import { toast } from "sonner";
import { format, formatDistanceStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CollapsibleJson, CopyJsonButton } from "@/components/flows/json-highlight";
import { cn } from "@/lib/utils";
import { usePermission } from "@/hooks/use-permission";
import { Skeleton } from "@/components/ui/skeleton";
import { CountUp } from "@/components/motion/count-up";
import { KpiStrip } from "@/components/ddm/kpi-strip";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { ErrorState } from "@/components/dashboard/error-state";

/**
 * Run history viewer.
 *
 * Lists the 50 most recent runs for a flow, newest first. Expanding a
 * row lazily fetches (`?run_id=`) and shows that run's
 * `flow_run_events` timeline — the engine's own step-by-step log
 * (migration 061 added node_completed/node_error/run_started/
 * run_completed/run_error on top of the pre-existing events), useful
 * for debugging "why didn't my flow advance?".
 */

interface RunRow {
  id: string;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "failed"
    | "error"
    | "transferred"
    | "delayed";
  current_node_key: string | null;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  hops_count: number;
  contact: { id: string; name: string | null; phone: string } | null;
}

interface EventRow {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  node_type: string | null;
  status: "success" | "error" | "skipped" | null;
  error_message: string | null;
  duration_ms: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Just enough of a flow_nodes row to render the "Nós não executados" list. */
interface FlowNodeDef {
  node_key: string;
  node_type: string;
}

/**
 * Per-run stats derived from its events, for the summary badges and
 * the "Nós não executados" section. `null` until the run has been
 * expanded at least once — events are fetched lazily per run (see
 * `toggle`), so there's nothing to compute from before that.
 */
interface RunEventStats {
  executedCount: number;
  errorCount: number;
  notExecuted: FlowNodeDef[];
}

function computeRunEventStats(
  events: EventRow[],
  flowNodes: FlowNodeDef[],
): RunEventStats {
  const executedKeys = new Set(
    events
      .filter((e) => e.event_type === "node_entered" && e.node_key)
      .map((e) => e.node_key as string),
  );
  // Uma falha por ocorrência (o motor grava a mesma falha 3x), sem
  // contar corridas inofensivas — mesmo critério do resumo.
  const errorCount = distinctFailures(events).length;
  const notExecuted = flowNodes.filter((n) => !executedKeys.has(n.node_key));
  return { executedCount: executedKeys.size, errorCount, notExecuted };
}

// Badge colors per the spec: green = completed, yellow = handed_off /
// delayed, red = error / failed, blue = active. The remaining statuses
// (timed_out, paused_by_agent, transferred) aren't called out in the
// spec — kept neutral/muted so they don't compete visually with the
// four called-out states.
const STATUS_META: Record<
  RunRow["status"],
  { label: string; tone: StatusTone; icon: typeof Clock }
> = {
  active: {
    label: "Ativo",
    tone: "info",
    icon: PlayCircle,
  },
  completed: {
    label: "Concluído",
    tone: "ok",
    icon: CircleCheck,
  },
  handed_off: {
    label: "Transferido",
    tone: "warn",
    icon: UserPlus,
  },
  delayed: {
    label: "Aguardando",
    tone: "warn",
    icon: Clock,
  },
  timed_out: {
    label: "Expirado",
    tone: "mute",
    icon: Clock,
  },
  paused_by_agent: {
    label: "Pausado pelo agente",
    tone: "mute",
    icon: PauseCircle,
  },
  failed: {
    label: "Falhou",
    tone: "bad",
    icon: CircleAlert,
  },
  error: {
    label: "Erro",
    tone: "bad",
    icon: CircleAlert,
  },
  transferred: {
    label: "Encaminhado a outro fluxo",
    tone: "mute",
    icon: ArrowRightLeft,
  },
};

const STATUS_FILTER_ALL = "all";

// The 7 statuses called out in the filter spec — a deliberate subset
// of STATUS_META's 9 (omits "delayed" and "transferred", which aren't
// part of the requested filter list). Labels reuse STATUS_META's
// wording where they match; "Pausado" is shortened from STATUS_META's
// "Pausado pelo agente" to fit the select trigger.
const STATUS_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: STATUS_FILTER_ALL, label: "Todos" },
  { value: "active", label: "Ativo" },
  { value: "completed", label: "Concluído" },
  { value: "handed_off", label: "Transferido" },
  { value: "failed", label: "Falhou" },
  { value: "timed_out", label: "Expirado" },
  { value: "paused_by_agent", label: "Pausado" },
  { value: "error", label: "Erro" },
  { value: "delayed", label: "Aguardando" },
  { value: "transferred", label: "Encaminhado a outro fluxo" },
];

export default function FlowRunsPage() {
  // Apagar histórico é escrita: DELETE /api/flows/[id]/runs exige flows.edit (ver as execuções segue com flows.view_runs).
  const canDelete = usePermission("flows.edit");
  const router = useRouter();
  const params = useParams<{ id: string }>();
  // ?run_id= (atalho "Fluxo" do inbox): abre já expandida e rolada até ela.
  const focusRunId = useSearchParams().get("run_id");
  const focusHandled = useRef(false);

  const [flow, setFlow] = useState<{ id: string; name: string } | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Full node graph for this flow — fetched once, reused across every
  // run's "Nós não executados" section (same flow for all of them).
  const [flowNodes, setFlowNodes] = useState<FlowNodeDef[]>([]);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventsByRun, setEventsByRun] = useState<Record<string, EventRow[]>>({});
  const [loadingEvents, setLoadingEvents] = useState<string | null>(null);
  // Only one run is ever expanded at a time, so a single selected-event
  // slot (rather than one per run) is enough — cleared on every toggle
  // so switching/collapsing runs never leaves a stale sheet open on an
  // event from a different run.
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);

  // ---- Filters ----
  const [statusFilter, setStatusFilter] = useState(STATUS_FILTER_ALL);
  const [contactInput, setContactInput] = useState("");
  // Debounced (500ms) copy of contactInput — this, not contactInput
  // directly, drives the fetch so typing doesn't fire a request per
  // keystroke.
  const [contactFilter, setContactFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const hasActiveFilters =
    statusFilter !== STATUS_FILTER_ALL ||
    contactInput.trim() !== "" ||
    dateFrom !== "" ||
    dateTo !== "";

  useEffect(() => {
    const t = setTimeout(() => {
      setContactFilter(contactInput.trim());
    }, 500);
    return () => clearTimeout(t);
  }, [contactInput]);

  function clearFilters() {
    setStatusFilter(STATUS_FILTER_ALL);
    setContactInput("");
    setContactFilter("");
    setDateFrom("");
    setDateTo("");
  }

  // ---- Selection + bulk delete ----
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Bumped after a successful delete to re-trigger the runs fetch below
  // without duplicating its fetch/error-handling logic in a callback.
  const [reloadKey, setReloadKey] = useState(0);
  const [loadError, setLoadError] = useState(false);
  // Paginação por deslocamento: `has_more` vem da API; sem ela (versão antiga) a lista é só a 1ª página.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const qs = new URLSearchParams();
        if (statusFilter !== STATUS_FILTER_ALL) qs.set("status", statusFilter);
        if (contactFilter) qs.set("contact", contactFilter);
        // A execução em foco vem na lista mesmo fora das 50/filtros, com eventos.
        if (focusRunId && !focusHandled.current) qs.set("run_id", focusRunId);
        if (dateFrom) {
          qs.set("date_from", new Date(`${dateFrom}T00:00:00`).toISOString());
        }
        if (dateTo) {
          qs.set("date_to", new Date(`${dateTo}T23:59:59.999`).toISOString());
        }
        const qsStr = qs.toString();
        const res = await apiFetch(
          `/api/flows/${params.id}/runs${qsStr ? `?${qsStr}` : ""}`,
        );
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as {
          flow: { id: string; name: string };
          runs: RunRow[];
          events?: EventRow[];
          has_more?: boolean;
        };
        if (!cancelled) {
          setFlow(json.flow);
          setRuns(json.runs ?? []);
          setHasMore(json.has_more === true);
          setMoreError(false);
          setSelected(new Set());
          if (focusRunId && !focusHandled.current && (json.runs ?? []).some((r) => r.id === focusRunId)) {
            focusHandled.current = true;
            setEventsByRun((prev) => ({ ...prev, [focusRunId]: json.events ?? [] }));
            setExpanded(focusRunId);
            window.setTimeout(() => {
              document.getElementById(`run-${focusRunId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 100);
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setLoadError(true);
          toast.error("Não foi possível carregar as execuções.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id, statusFilter, contactFilter, dateFrom, dateTo, reloadKey, focusRunId]);

  async function loadMoreRuns() {
    if (!params.id) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const qs = new URLSearchParams();
      if (statusFilter !== STATUS_FILTER_ALL) qs.set("status", statusFilter);
      if (contactFilter) qs.set("contact", contactFilter);
      if (dateFrom) qs.set("date_from", new Date(`${dateFrom}T00:00:00`).toISOString());
      if (dateTo) qs.set("date_to", new Date(`${dateTo}T23:59:59.999`).toISOString());
      qs.set("offset", String(runs.length));
      const res = await apiFetch(`/api/flows/${params.id}/runs?${qs.toString()}`);
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const json = (await res.json()) as { runs: RunRow[]; has_more?: boolean };
      setRuns((prev) => {
        const known = new Set(prev.map((r) => r.id));
        return [...prev, ...(json.runs ?? []).filter((r) => !known.has(r.id))];
      });
      setHasMore(json.has_more === true);
    } catch (err) {
      console.error(err);
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  // Independent of the runs fetch above — a failure here just means
  // "Nós não executados" stays empty everywhere, not a page-breaking
  // error, so it doesn't share the same loading/notFound state.
  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/flows/${params.id}`);
        if (!res.ok) return;
        const json = (await res.json()) as {
          nodes?: Array<{ node_key: string; node_type: string }>;
        };
        if (!cancelled) {
          setFlowNodes(
            (json.nodes ?? []).map((n) => ({
              node_key: n.node_key,
              node_type: n.node_type,
            })),
          );
        }
      } catch (err) {
        console.error("[flows-runs] flow nodes fetch failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  async function toggle(runId: string) {
    setSelectedEvent(null);
    if (expanded === runId) {
      setExpanded(null);
      return;
    }
    setExpanded(runId);
    if (eventsByRun[runId]) return;
    setLoadingEvents(runId);
    try {
      const res = await apiFetch(`/api/flows/${params.id}/runs?run_id=${runId}`);
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const json = (await res.json()) as { events: EventRow[] };
      setEventsByRun((prev) => ({ ...prev, [runId]: json.events ?? [] }));
    } catch (err) {
      console.error(err);
      toast.error("Não foi possível carregar o log desta execução.");
    } finally {
      setLoadingEvents(null);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allVisibleSelected = runs.length > 0 && runs.every((r) => selected.has(r.id));
  const someVisibleSelected = runs.some((r) => selected.has(r.id));

  function toggleSelectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        runs.forEach((r) => next.delete(r.id));
      } else {
        runs.forEach((r) => next.add(r.id));
      }
      return next;
    });
  }

  async function deleteRuns(ids: string[]) {
    if (ids.length === 0) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/flows/${params.id}/runs`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const json = (await res.json()) as { deleted: number };
      toast.success(
        `${json.deleted} execuç${json.deleted === 1 ? "ão excluída" : "ões excluídas"}`,
      );
      setSelected(new Set());
      setReloadKey((k) => k + 1);
    } catch (err) {
      console.error(err);
      toast.error("Não foi possível excluir as execuções.");
    } finally {
      setDeleting(false);
    }
  }

  async function handleBulkDelete() {
    await deleteRuns([...selected]);
    setBulkDeleteOpen(false);
  }

  async function handleDeleteAll() {
    await deleteRuns(runs.map((r) => r.id));
    setDeleteAllOpen(false);
  }

  if (loading && !flow && !loadError) {
    return (
      <PageBody>
        <div className="flex flex-col gap-2 pt-1" aria-busy="true">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-7 w-48" />
        </div>
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[62px] w-full rounded-[10px]" />
          ))}
        </div>
      </PageBody>
    );
  }
  if (loadError && !flow) {
    return (
      <PageBody>
        <ErrorState
          title="Não foi possível carregar as execuções"
          hint="Verifique a conexão e tente de novo."
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      </PageBody>
    );
  }
  if (notFound || !flow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Fluxo não encontrado.</p>
        <button
          type="button"
          onClick={() => router.push("/flows")}
          className="text-sm text-primary-text hover:opacity-80"
        >
          ← Voltar para fluxos
        </button>
      </div>
    );
  }

  // Contagens só das execuções listadas (as 50 mais recentes após os filtros).
  const runCounts = {
    completed: runs.filter((r) => r.status === "completed").length,
    active: runs.filter((r) => r.status === "active" || r.status === "delayed").length,
    failed: runs.filter((r) => r.status === "failed" || r.status === "error").length,
  };

  return (
    <PageBody>
      <div className="flex flex-col gap-1.5 pt-1">
        <button
          type="button"
          onClick={() => router.push(`/flows/${flow.id}`)}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          {flow.name}
        </button>
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Execuções</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          As 50 execuções mais recentes deste fluxo (após os filtros abaixo).
          Clique em uma linha para ver o log passo a passo do motor.
        </p>
      </div>

      {runs.length > 0 && (
        <KpiStrip
          ariaLabel="Resumo das execuções listadas"
          items={[
            { label: "Listadas", value: <CountUp value={runs.length} />, info: "Execuções carregadas abaixo, após os filtros. Use Carregar mais para ver as anteriores." },
            { label: "Concluídas", value: <CountUp value={runCounts.completed} className="text-success" /> },
            { label: "Em andamento", value: <CountUp value={runCounts.active} /> },
            {
              label: "Com erro",
              value: <CountUp value={runCounts.failed} className={runCounts.failed > 0 ? "text-danger" : undefined} />,
              onClick: () => setStatusFilter(statusFilter === "failed" ? STATUS_FILTER_ALL : "failed"),
              active: statusFilter === "failed",
              title: "Filtrar execuções que falharam",
            },
          ]}
        />
      )}

      {/* Filtros */}
      <PageToolbar
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              disabled={!hasActiveFilters}
              className="text-muted-foreground hover:text-foreground"
            >
              Limpar filtros
            </Button>
            <GatedButton
              variant="outline"
              size="sm"
              canAct={canDelete}
              gateReason="excluir execuções"
              disabled={runs.length === 0}
              onClick={() => setDeleteAllOpen(true)}
              className="text-danger hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 className="size-3.5" />
              Excluir todas
            </GatedButton>
          </>
        }
      >
        <label className="relative flex min-w-0 flex-[1_1_220px] items-center sm:max-w-[320px]">
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            placeholder="Buscar por nome ou telefone"
            aria-label="Filtrar por contato"
            value={contactInput}
            onChange={(e) => setContactInput(e.target.value)}
            className="h-[34px] w-full rounded-md border border-border bg-card pl-[34px] pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
          />
        </label>
        <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
          <SelectTrigger className="h-[34px] w-40 text-xs" aria-label="Filtrar por status">
            <SelectValue>
              {(v: string) => STATUS_FILTER_OPTIONS.find((o) => o.value === v)?.label ?? v}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          De
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="Data inicial"
            className="h-[34px] w-36 text-xs"
          />
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Até
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="Data final"
            className="h-[34px] w-36 text-xs"
          />
        </span>
      </PageToolbar>

      {/* Seleção + ações em massa */}
      <div className="flex min-h-[38px] flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-card px-4 py-1.5">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={allVisibleSelected}
            indeterminate={!allVisibleSelected && someVisibleSelected}
            onCheckedChange={toggleSelectAllVisible}
            disabled={runs.length === 0}
            aria-label="Selecionar todas as execuções visíveis"
          />
          {selected.size > 0 ? (
            <span className="text-foreground">
              <span className="font-semibold">{selected.size}</span> selecionado{selected.size === 1 ? "" : "s"}
            </span>
          ) : (
            "Selecionar todos"
          )}
        </label>
        {selected.size > 0 && (
          <div className="flex animate-ddm-fade items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              Limpar seleção
            </Button>
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canDelete}
              gateReason="excluir execuções"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="size-3.5" />
              Excluir selecionados
            </GatedButton>
          </div>
        )}
      </div>

      {loadError ? (
        <ErrorState
          title="Não foi possível carregar as execuções"
          hint="Verifique a conexão e tente de novo."
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : runs.length === 0 ? (
        <div className="flex animate-ddm-fade flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-border bg-card px-6 py-12 text-center">
          <p className="text-[13.5px] font-semibold text-foreground">
            {hasActiveFilters ? "Nada encontrado" : "Nenhuma execução ainda"}
          </p>
          <p className="text-[12.5px] text-muted-foreground">
            {hasActiveFilters
              ? "Nenhuma execução corresponde aos filtros aplicados."
              : "Dispare o fluxo a partir de um número do WhatsApp para vê-lo aparecer aqui."}
          </p>
        </div>
      ) : (
        <div className="ddm-stagger relative flex flex-col gap-2">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-[10px] bg-background/60">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              focused={run.id === focusRunId}
              selected={selected.has(run.id)}
              onToggleSelect={() => toggleSelect(run.id)}
              events={eventsByRun[run.id] ?? null}
              loadingEvents={loadingEvents === run.id}
              expanded={expanded === run.id}
              onToggle={() => void toggle(run.id)}
              selectedEvent={selectedEvent}
              onSelectEvent={setSelectedEvent}
              flowNodes={flowNodes}
              onViewInDiagram={() => router.push(`/flows/${flow.id}?run_id=${run.id}`)}
            />
          ))}
        </div>
      )}

      {hasMore && !loading && !loadError && runs.length > 0 && (
        <div className="flex flex-col items-center gap-2">
          {moreError && (
            <p role="alert" className="text-xs text-danger">
              Não foi possível carregar mais execuções. Tente de novo.
            </p>
          )}
          <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void loadMoreRuns()}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}

      <EventDetailSheet
        ev={selectedEvent}
        onClose={() => setSelectedEvent(null)}
      />

      {/* Bulk delete confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Excluir {selected.size} {selected.size === 1 ? "execução" : "execuções"}
            </DialogTitle>
            <DialogDescription>
              Tem certeza que deseja excluir{" "}
              <span className="font-medium text-foreground">
                {selected.size} {selected.size === 1 ? "execução" : "execuções"}
              </span>
              ? Os logs de eventos dessas execuções também serão excluídos. Esta
              ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* "Excluir todas" confirmation */}
      <Dialog open={deleteAllOpen} onOpenChange={setDeleteAllOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir todas as execuções listadas</DialogTitle>
            <DialogDescription>
              Tem certeza que deseja excluir{" "}
              <span className="font-medium text-foreground">
                {runs.length} {runs.length === 1 ? "execução" : "execuções"}
              </span>{" "}
              {hasActiveFilters
                ? "que correspondem aos filtros aplicados"
                : "listadas"}
              ? Os logs de eventos dessas execuções também serão excluídos. Esta
              ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteAllOpen(false)}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleDeleteAll} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}

function RunCard({
  run,
  focused,
  selected,
  onToggleSelect,
  events,
  loadingEvents,
  expanded,
  onToggle,
  selectedEvent,
  onSelectEvent,
  flowNodes,
  onViewInDiagram,
}: {
  run: RunRow;
  /** Execução aberta pelo atalho do inbox (?run_id=). */
  focused?: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  events: EventRow[] | null;
  loadingEvents: boolean;
  expanded: boolean;
  onToggle: () => void;
  selectedEvent: EventRow | null;
  onSelectEvent: (ev: EventRow) => void;
  flowNodes: FlowNodeDef[];
  onViewInDiagram: () => void;
}) {
  // Status novo no banco sem rótulo aqui não pode quebrar a tela.
  const meta = STATUS_META[run.status] ?? { label: run.status, tone: "mute" as const, icon: Circle };
  const StatusIcon = meta.icon;
  const contactLabel =
    run.contact?.name?.trim() || run.contact?.phone || "Contato desconhecido";
  const duration = run.ended_at
    ? // Duração = início → fim (antes media o tempo desde o fim).
      formatDistanceStrict(new Date(run.started_at), new Date(run.ended_at), {
        locale: ptBR,
      })
    : null;
  // null until the run has been expanded at least once — events are
  // fetched lazily per run, so there's nothing to derive stats from
  // before that (see the file header comment on why events aren't
  // bulk-fetched for the whole list).
  const stats = events ? computeRunEventStats(events, flowNodes) : null;
  const summary = events ? summarizeRun(run, events) : null;
  // "Só o importante": esconde entrada/conclusão de nó sem conteúdo.
  const [onlyImportant, setOnlyImportant] = useState(true);
  const visibleEvents = events ? (onlyImportant ? events.filter((e) => !isRoutineEvent(e)) : events) : null;
  return (
    <div
      id={`run-${run.id}`}
      className={cn(
        "scroll-mt-4 rounded-[10px] border bg-card transition-[border-color,box-shadow] duration-200 ease-ddm",
        focused ? "border-primary shadow-[0_0_0_3px_var(--primary-soft-2)]" : "border-border hover:border-border-strong",
      )}
    >
      <div className="flex w-full flex-wrap items-center gap-2 px-4 py-3">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Selecionar execução de ${contactLabel}`}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`run-${run.id}-details`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {contactLabel}
            </span>
            <StatusChip tone={meta.tone} dot={false}>
              <StatusIcon className="size-3" aria-hidden="true" />
              {meta.label}
            </StatusChip>
            {run.status === "active" && run.current_node_key && (
              <code className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                em {run.current_node_key}
              </code>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>Iniciado em {format(new Date(run.started_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}</span>
            <span>
              · {run.hops_count} {run.hops_count === 1 ? "nó executado" : "nós executados"}
            </span>
            {run.reprompt_count > 0 && (
              <span>· {run.reprompt_count} repergunta{run.reprompt_count === 1 ? "" : "s"}</span>
            )}
            {duration && <span>· durou {duration}</span>}
          </div>
          {stats && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusChip tone="ok">{stats.executedCount} executados</StatusChip>
              {stats.errorCount > 0 && (
                <StatusChip tone="bad">
                  {stats.errorCount} {stats.errorCount === 1 ? "erro" : "erros"}
                </StatusChip>
              )}
              {stats.notExecuted.length > 0 && (
                <StatusChip tone="mute" title="Ramos não escolhidos e passos que ainda não chegaram — não indica erro">
                  {stats.notExecuted.length} não alcançados
                </StatusChip>
              )}
            </div>
          )}
        </div>
      </button>
      {expanded && events && (
        <button
          type="button"
          onClick={onViewInDiagram}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-text transition-colors hover:bg-primary-soft"
        >
          <GitBranch className="h-3.5 w-3.5" />
          Ver no diagrama
        </button>
      )}
      </div>
      {expanded && (
        <div id={`run-${run.id}-details`} className="border-t border-border px-4 py-3">
          {summary && (
            <div className="mb-3 rounded-md border border-border bg-surface-3 px-3 py-2">
              <p className="text-sm font-medium text-foreground">{summary.headline}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {summary.messagesSent} mensage{summary.messagesSent === 1 ? "m enviada" : "ns enviadas"} ·{" "}
                {summary.replies} resposta{summary.replies === 1 ? "" : "s"} do cliente
                {summary.toolCalls > 0 && (
                  <>
                    {" "}· {summary.toolCalls} ferramenta{summary.toolCalls === 1 ? "" : "s"} da IA
                    {summary.toolErrors > 0 && ` (${summary.toolErrors} com erro)`}
                  </>
                )}
                {summary.errors > 0 && <> · {summary.errors} erro{summary.errors === 1 ? "" : "s"}</>}
              </p>
            </div>
          )}
          {Object.keys(run.vars).length > 0 && (
            <details className="mb-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Variáveis capturadas ({Object.keys(run.vars).length})
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-background p-2 text-[11px] text-muted-foreground">
                {JSON.stringify(run.vars, null, 2)}
              </pre>
            </details>
          )}
          {loadingEvents ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {events && events.length > 0 && (
                <label className="mb-1.5 flex w-fit cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                  <Checkbox checked={onlyImportant} onCheckedChange={(v) => setOnlyImportant(!!v)} />
                  Só o importante ({events.length - (visibleEvents?.length ?? 0)} passos internos ocultos)
                </label>
              )}
              <div className="flex flex-col gap-1">
                {!events || events.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nenhum evento registrado para esta execução.
                  </p>
                ) : (
                  (visibleEvents ?? []).map((ev, ix) => (
                    <EventLine
                      key={`${ev.created_at}-${ev.event_type}-${ix}`}
                      ev={ev}
                      selected={selectedEvent === ev}
                      onSelect={() => onSelectEvent(ev)}
                    />
                  ))
                )}
              </div>
              {stats && stats.notExecuted.length > 0 && (
                <NotExecutedSection nodes={stats.notExecuted} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Flow nodes the run's event log never reached (no node_entered for
 * that node_key). Rendered as its own section, separate from the
 * event timeline, since these never happened rather than happened
 * with some outcome.
 */
function NotExecutedSection({ nodes }: { nodes: FlowNodeDef[] }) {
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Nós não alcançados
      </p>
      <p className="mb-1.5 text-[11px] text-muted-foreground">
        Inclui os ramos que o cliente não escolheu e os passos depois de onde a execução parou. Não indica erro.
      </p>
      <div className="flex flex-col gap-1">
        {nodes.map((n) => (
          <div
            key={n.node_key}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
          >
            <MinusCircle className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="min-w-0 truncate rounded bg-surface-3 px-1 py-0.5 text-[10px] text-muted-foreground">
              {n.node_key} ({NODE_META[n.node_type as NodeType]?.label ?? n.node_type})
            </code>
            <span className="hidden text-[10.5px] text-muted-foreground sm:inline">
              Não alcançado nesta execução
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Base per-event_type icon/color. `node_completed` defaults to the
// success (green) look; getEventIcon/getEventColor override it to the
// error (red) look when that particular row's `status` is "error" —
// engine.ts never writes node_completed with status:"error" today
// (node_error is its own event_type for failures), but the DB column
// allows it, so this stays defensive rather than assuming.
const EVENT_ICON: Record<string, typeof Clock> = {
  started: Play,
  run_started: Play,
  node_entered: ChevronRight,
  node_completed: CheckCircle,
  message_sent: MessageCircle,
  reply_received: MessageSquare,
  fallback_fired: Clock,
  handoff: UserPlus,
  timeout: Clock,
  error: XCircle,
  node_error: XCircle,
  completed: CheckCircle,
  run_completed: CheckCircle2,
  run_error: XCircle,
  tool_called: Wrench,
  tool_result: Wrench,
  ai_agent_takeover: Bot,
  ai_agent_failed: XCircle,
};

const EVENT_COLOR: Record<string, string> = {
  started: "text-success",
  run_started: "text-success",
  node_entered: "text-muted-foreground",
  node_completed: "text-success",
  message_sent: "text-primary-text",
  reply_received: "text-foreground-2",
  fallback_fired: "text-warning",
  handoff: "text-warning",
  timeout: "text-muted-foreground",
  error: "text-danger",
  node_error: "text-danger",
  completed: "text-success",
  run_completed: "text-success",
  run_error: "text-danger",
  tool_called: "text-violet-500",
  tool_result: "text-violet-500",
  ai_agent_takeover: "text-violet-500",
  ai_agent_failed: "text-danger",
};

function getEventIcon(ev: EventRow): typeof Clock {
  if (ev.event_type === "node_completed" && ev.status === "error") return XCircle;
  return EVENT_ICON[ev.event_type] ?? Circle;
}

function getEventColor(ev: EventRow): string {
  if (ev.event_type === "node_completed" && ev.status === "error") return "text-danger";
  if (ev.event_type === "tool_result" && ev.status === "error") return "text-danger";
  return EVENT_COLOR[ev.event_type] ?? "text-muted-foreground";
}

function EventLine({
  ev,
  selected,
  onSelect,
}: {
  ev: EventRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const cls = getEventColor(ev);
  const iconComponent = getEventIcon(ev);
  const isError =
    ev.event_type === "error" ||
    ev.event_type === "node_error" ||
    ev.event_type === "run_error" ||
    ev.event_type === "ai_agent_failed" ||
    (ev.event_type === "tool_result" && ev.status === "error");
  const isNodeError = ev.event_type === "node_error";
  const nodeTypeLabel = ev.node_type ? NODE_META[ev.node_type as NodeType]?.label ?? ev.node_type : null;
  const sentence = describeEvent(ev);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1 text-left text-xs transition-colors",
        !isNodeError && (selected ? "bg-muted" : "hover:bg-muted/50"),
        isNodeError && (selected ? "bg-danger/20" : "bg-danger-soft hover:bg-danger/20")
      )}
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
        {createElement(iconComponent, {
          className: cn("mt-0.5 h-3 w-3 shrink-0", cls),
        })}
        <span className="w-14 shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {format(new Date(ev.created_at), "HH:mm:ss")}
        </span>
        <span className={cn("shrink-0 text-[11px] font-medium sm:w-36", cls)} title={ev.event_type}>
          {EVENT_LABEL[ev.event_type] ?? ev.event_type}
        </span>
        {ev.node_key && (
          <code className="min-w-0 max-w-full truncate rounded bg-surface-3 px-1 py-0.5 text-[10px] text-muted-foreground" title={ev.node_type ?? undefined}>
            {nodeTypeLabel ? `${nodeTypeLabel} · ${ev.node_key}` : ev.node_key}
          </code>
        )}
        {typeof ev.duration_ms === "number" && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
            <Timer className="h-2.5 w-2.5" />
            {ev.duration_ms}ms
          </span>
        )}
        {!isError && sentence && sentence !== EVENT_LABEL[ev.event_type] && (
          <span className="min-w-0 basis-full truncate text-[11px] text-foreground/80 sm:basis-auto sm:flex-1" title={sentence}>
            {sentence}
          </span>
        )}
      </div>
      {isError && <p className="ml-5 text-[11px] text-danger">{sentence}</p>}
    </button>
  );
}


// ============================================================
// Event detail sheet — n8n-style "click a step, see its full
// input/output" panel. Body rendering is keyed off payload SHAPE, same
// convention `summarizePayload` above already established (`node_type`
// is null on most rows — only `logRunEvent`'s node_completed/node_error
// siblings set it — so it can't be the switch key here either).
// ============================================================

const STATUS_BADGE: Record<
  string,
  { label: string; classes: string; icon: typeof CircleCheck }
> = {
  success: {
    label: "Sucesso",
    classes: "border-success/40 bg-success-soft text-success",
    icon: CircleCheck,
  },
  error: {
    label: "Erro",
    classes: "border-danger/40 bg-danger-soft text-danger",
    icon: CircleAlert,
  },
  skipped: {
    label: "Ignorado",
    classes: "border-border bg-muted text-muted-foreground",
    icon: MinusCircle,
  },
};

/** Section wrapper — label + a CollapsibleJson body, used for Input/Output. */
function PayloadSection({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <CollapsibleJson value={value} />
    </div>
  );
}

/**
 * Full payload detail — Input / Output / Erro sections when the
 * payload follows the {input, output, error_message?} shape (every
 * node_completed/node_error event does). Payloads that predate that
 * shape (message_sent, node_entered, handoff, reply_received, or any
 * node_completed logged before this rollout) don't have input/output
 * keys — those fall back to one syntax-highlighted JSON dump of the
 * whole payload, so nothing old breaks.
 */
function EventPayloadBody({ ev }: { ev: EventRow }) {
  const payload = ev.payload;
  const hasInputOutput = "input" in payload || "output" in payload;
  const errorMessage = ev.error_message ?? (payload.error_message as string | undefined);
  const errorStack = payload.error_stack as string | null | undefined;

  if (!hasInputOutput && Object.keys(payload).length === 0 && !errorMessage) {
    return <p className="text-xs text-muted-foreground">Sem payload.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {errorMessage && (
        <div>
          <p className="mb-1 text-[11px] font-semibold tracking-wide text-danger uppercase">
            Erro
          </p>
          {/* Frase legível primeiro; o texto cru e o stack ficam recolhidos. */}
          <p className="rounded-md bg-danger-soft p-2 text-xs text-foreground">
            {humanizeError(errorMessage) ?? errorMessage}
          </p>
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">Detalhes técnicos</summary>
            <p className="mt-1 break-words rounded-md bg-surface-3 p-2 font-mono text-[11px] text-muted-foreground">
              {errorMessage}
            </p>
            {errorStack && (
              <div className="mt-1">
                <CollapsibleJson value={errorStack} />
              </div>
            )}
          </details>
        </div>
      )}

      {hasInputOutput ? (
        <>
          {"input" in payload && <PayloadSection label="Entrada" value={payload.input} />}
          {"output" in payload && <PayloadSection label="Saída" value={payload.output} />}
        </>
      ) : (
        <PayloadSection label="Payload" value={payload} />
      )}
    </div>
  );
}

function EventDetailSheet({
  ev,
  onClose,
}: {
  ev: EventRow | null;
  onClose: () => void;
}) {
  const open = ev !== null;
  if (!ev) return null;
  const iconComponent = getEventIcon(ev);
  const cls = getEventColor(ev);
  const statusMeta = ev.status ? STATUS_BADGE[ev.status] : null;
  const StatusIcon = statusMeta?.icon;
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="flex items-center gap-2 text-sm">
            {createElement(iconComponent, {
              className: cn("h-4 w-4 shrink-0", cls),
            })}
            <span className={cls}>{EVENT_LABEL[ev.event_type] ?? ev.event_type}</span>
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2 pt-1">
            {ev.node_key && (
              <code className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {ev.node_type ? `${ev.node_key} (${NODE_META[ev.node_type as NodeType]?.label ?? ev.node_type})` : ev.node_key}
              </code>
            )}
            <code className="text-[10px] text-muted-foreground" title="Tipo técnico do evento">{ev.event_type}</code>
            {statusMeta && StatusIcon && (
              <Badge variant="outline" className={cn("gap-1", statusMeta.classes)}>
                <StatusIcon className="h-3 w-3" />
                {statusMeta.label}
              </Badge>
            )}
            {typeof ev.duration_ms === "number" && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <Timer className="h-2.5 w-2.5" />
                {ev.duration_ms}ms
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-3 text-sm text-foreground">{describeEvent(ev)}</p>
          <div className="mb-3 flex justify-end">
            <CopyJsonButton value={ev.payload} />
          </div>
          <EventPayloadBody ev={ev} />
        </div>

        <SheetFooter className="border-t border-border px-5 py-3">
          <span className="text-[11px] text-muted-foreground">
            {format(new Date(ev.created_at), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}
          </span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
