"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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
  Copy,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";

import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

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

// Badge colors per the spec: green = completed, yellow = handed_off /
// delayed, red = error / failed, blue = active. The remaining statuses
// (timed_out, paused_by_agent, transferred) aren't called out in the
// spec — kept neutral/muted so they don't compete visually with the
// four called-out states.
const STATUS_META: Record<
  RunRow["status"],
  { label: string; classes: string; icon: typeof Clock }
> = {
  active: {
    label: "Ativo",
    classes: "border-sky-600/40 bg-sky-500/10 text-sky-300",
    icon: PlayCircle,
  },
  completed: {
    label: "Concluído",
    classes: "border-emerald-600/40 bg-emerald-500/10 text-emerald-300",
    icon: CircleCheck,
  },
  handed_off: {
    label: "Transferido",
    classes: "border-amber-600/40 bg-amber-500/10 text-amber-300",
    icon: UserPlus,
  },
  delayed: {
    label: "Aguardando",
    classes: "border-amber-600/40 bg-amber-500/10 text-amber-300",
    icon: Clock,
  },
  timed_out: {
    label: "Expirado",
    classes: "border-border bg-muted/60 text-muted-foreground",
    icon: Clock,
  },
  paused_by_agent: {
    label: "Pausado pelo agente",
    classes: "border-border bg-muted text-muted-foreground",
    icon: PauseCircle,
  },
  failed: {
    label: "Falhou",
    classes: "border-red-600/40 bg-red-500/10 text-red-300",
    icon: CircleAlert,
  },
  error: {
    label: "Erro",
    classes: "border-red-600/40 bg-red-500/10 text-red-300",
    icon: CircleAlert,
  },
  transferred: {
    label: "Encaminhado a outro fluxo",
    classes: "border-border bg-muted text-muted-foreground",
    icon: ArrowRightLeft,
  },
};

export default function FlowRunsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();

  const [flow, setFlow] = useState<{ id: string; name: string } | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventsByRun, setEventsByRun] = useState<Record<string, EventRow[]>>({});
  const [loadingEvents, setLoadingEvents] = useState<string | null>(null);
  // Only one run is ever expanded at a time, so a single selected-event
  // slot (rather than one per run) is enough — cleared on every toggle
  // so switching/collapsing runs never leaves a stale sheet open on an
  // event from a different run.
  const [selectedEvent, setSelectedEvent] = useState<EventRow | null>(null);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/flows/${params.id}/runs`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as {
          flow: { id: string; name: string };
          runs: RunRow[];
        };
        if (!cancelled) {
          setFlow(json.flow);
          setRuns(json.runs ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error("Não foi possível carregar as execuções.");
        }
      } finally {
        if (!cancelled) setLoading(false);
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
      const res = await fetch(`/api/flows/${params.id}/runs?run_id=${runId}`);
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

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (notFound || !flow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Fluxo não encontrado.</p>
        <button
          type="button"
          onClick={() => router.push("/flows")}
          className="text-sm text-primary hover:opacity-80"
        >
          ← Voltar para fluxos
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <button
        type="button"
        onClick={() => router.push(`/flows/${flow.id}`)}
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        {flow.name}
      </button>
      <h1 className="text-xl font-semibold text-foreground">Execuções</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        As 50 execuções mais recentes deste fluxo. Clique em uma linha para ver
        o log passo a passo do motor.
      </p>

      {runs.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-border bg-card/50 px-6 py-12 text-center text-sm text-muted-foreground">
          Nenhuma execução ainda. Dispare o fluxo a partir de um número do
          WhatsApp para vê-lo aparecer aqui.
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-2">
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              events={eventsByRun[run.id] ?? null}
              loadingEvents={loadingEvents === run.id}
              expanded={expanded === run.id}
              onToggle={() => void toggle(run.id)}
              selectedEvent={selectedEvent}
              onSelectEvent={setSelectedEvent}
            />
          ))}
        </div>
      )}

      <EventDetailSheet
        ev={selectedEvent}
        onClose={() => setSelectedEvent(null)}
      />
    </div>
  );
}

function RunCard({
  run,
  events,
  loadingEvents,
  expanded,
  onToggle,
  selectedEvent,
  onSelectEvent,
}: {
  run: RunRow;
  events: EventRow[] | null;
  loadingEvents: boolean;
  expanded: boolean;
  onToggle: () => void;
  selectedEvent: EventRow | null;
  onSelectEvent: (ev: EventRow) => void;
}) {
  const meta = STATUS_META[run.status];
  const StatusIcon = meta.icon;
  const contactLabel =
    run.contact?.name?.trim() || run.contact?.phone || "Contato desconhecido";
  const duration = run.ended_at
    ? formatDistanceToNow(new Date(run.ended_at), {
        addSuffix: false,
      })
    : null;
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {contactLabel}
            </span>
            <Badge variant="outline" className={cn("gap-1", meta.classes)}>
              <StatusIcon className="h-3 w-3" />
              {meta.label}
            </Badge>
            {run.status === "active" && run.current_node_key && (
              <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                em {run.current_node_key}
              </code>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>Iniciado em {format(new Date(run.started_at), "PP p")}</span>
            <span>
              · {run.hops_count} {run.hops_count === 1 ? "nó executado" : "nós executados"}
            </span>
            {run.reprompt_count > 0 && (
              <span>· {run.reprompt_count} repergunta{run.reprompt_count === 1 ? "" : "s"}</span>
            )}
            {duration && <span>· durou {duration}</span>}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-3">
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
            <div className="flex flex-col gap-1">
              {!events || events.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nenhum evento registrado para esta execução.
                </p>
              ) : (
                events.map((ev, ix) => (
                  <EventLine
                    key={ix}
                    ev={ev}
                    selected={selectedEvent === ev}
                    onSelect={() => onSelectEvent(ev)}
                  />
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const EVENT_ICON: Record<string, typeof Clock> = {
  started: PlayCircle,
  run_started: PlayCircle,
  node_entered: ChevronRight,
  node_completed: CircleCheck,
  message_sent: CircleCheck,
  reply_received: ChevronRight,
  fallback_fired: Clock,
  handoff: UserPlus,
  timeout: Clock,
  error: CircleAlert,
  node_error: CircleAlert,
  completed: CircleCheck,
  run_completed: CircleCheck,
  run_error: CircleAlert,
};

const EVENT_COLOR: Record<string, string> = {
  started: "text-emerald-300",
  run_started: "text-emerald-300",
  node_entered: "text-muted-foreground",
  node_completed: "text-emerald-300",
  message_sent: "text-sky-300",
  reply_received: "text-primary",
  fallback_fired: "text-amber-300",
  handoff: "text-amber-300",
  timeout: "text-muted-foreground",
  error: "text-red-300",
  node_error: "text-red-300",
  completed: "text-emerald-300",
  run_completed: "text-emerald-300",
  run_error: "text-red-300",
};

function EventLine({
  ev,
  selected,
  onSelect,
}: {
  ev: EventRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const cls = EVENT_COLOR[ev.event_type] ?? "text-muted-foreground";
  const Icon = EVENT_ICON[ev.event_type] ?? ChevronRight;
  const isError = ev.event_type === "node_error" || ev.event_type === "run_error";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1 text-left text-xs transition-colors",
        selected ? "bg-muted" : "hover:bg-muted/50"
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", cls)} />
        <span className="w-28 shrink-0 text-[10px] text-muted-foreground">
          {format(new Date(ev.created_at), "HH:mm:ss")}
        </span>
        <span className={cn("w-32 shrink-0 font-mono text-[10px]", cls)}>
          {ev.event_type}
        </span>
        {ev.node_key && (
          <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
            {ev.node_type ? `${ev.node_key} (${ev.node_type})` : ev.node_key}
          </code>
        )}
        {typeof ev.duration_ms === "number" && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
            <Timer className="h-2.5 w-2.5" />
            {ev.duration_ms}ms
          </span>
        )}
        {!isError && Object.keys(ev.payload).length > 0 && (
          <span className="min-w-0 truncate text-[10px] text-muted-foreground">
            {summarizePayload(ev.payload)}
          </span>
        )}
      </div>
      {isError && ev.error_message && (
        <p className="ml-9 text-[10px] text-red-400">{ev.error_message}</p>
      )}
    </button>
  );
}

function summarizePayload(payload: Record<string, unknown>): string {
  // Type-specific renderings first — richer than the generic key dump
  // below. Detected by payload shape (not `node_type`, which the
  // `logEvent` helper these all go through never sets on the row —
  // only `logRunEvent`'s node_completed/node_error siblings do).
  if ("fell_through" in payload) {
    if (payload.fell_through === true) return "Senão (fallback)";
    if (typeof payload.branch_chosen === "string") {
      return `Ramo: ${payload.branch_chosen}`;
    }
  }
  if (Array.isArray(payload.variables_set)) {
    const vars = payload.variables_set as Array<{ key: string; value: string }>;
    return vars.map((v) => `Setou: ${v.key} = ${v.value}`).join(" · ");
  }
  if (typeof payload.last_reply === "string" && payload.last_reply) {
    return payload.last_reply.slice(0, 100);
  }

  // Show the keys that matter most to a human debugger; full JSON is
  // available via the "Captured vars" details panel for the run.
  const keys = ["reply_id", "captured_key", "reason", "advancing_to"];
  for (const k of keys) {
    if (k in payload && payload[k] !== null && payload[k] !== undefined) {
      return `${k}=${String(payload[k]).slice(0, 80)}`;
    }
  }
  return "";
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
    classes: "border-emerald-600/40 bg-emerald-500/10 text-emerald-300",
    icon: CircleCheck,
  },
  error: {
    label: "Erro",
    classes: "border-red-600/40 bg-red-500/10 text-red-300",
    icon: CircleAlert,
  },
  skipped: {
    label: "Ignorado",
    classes: "border-border bg-muted text-muted-foreground",
    icon: MinusCircle,
  },
};

// ============================================================
// JSON syntax highlighting — no library, just a small tokenizer over
// JSON.stringify's output. Keys render in the DDM brand orange
// (#FF5706) per spec; strings/numbers/booleans/null get distinct,
// readable colors against the dark background.
// ============================================================

const JSON_TOKEN_RE =
  /"(?:\\.|[^"\\])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlightJson(json: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  JSON_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_TOKEN_RE.exec(json))) {
    if (match.index > lastIndex) {
      nodes.push(json.slice(lastIndex, match.index));
    }
    const tok = match[0];
    if (tok.endsWith(":")) {
      nodes.push(
        <span key={key++} style={{ color: "#FF5706" }}>
          {tok}
        </span>,
      );
    } else if (tok.startsWith('"')) {
      nodes.push(
        <span key={key++} className="text-emerald-300">
          {tok}
        </span>,
      );
    } else if (tok === "true" || tok === "false") {
      nodes.push(
        <span key={key++} className="text-sky-300">
          {tok}
        </span>,
      );
    } else if (tok === "null") {
      nodes.push(
        <span key={key++} className="text-neutral-500">
          {tok}
        </span>,
      );
    } else {
      nodes.push(
        <span key={key++} className="text-purple-300">
          {tok}
        </span>,
      );
    }
    lastIndex = JSON_TOKEN_RE.lastIndex;
  }
  if (lastIndex < json.length) nodes.push(json.slice(lastIndex));
  return nodes;
}

const COLLAPSE_THRESHOLD = 500;

/**
 * Dark, mono, syntax-highlighted JSON block. Collapses to the first
 * COLLAPSE_THRESHOLD chars with a "Ver mais" toggle when the
 * formatted JSON is longer than that — full detail is one click away,
 * not hidden, just not dumped on-screen by default for a fat payload
 * (e.g. an http_fetch response_body or a long ai_agent last_reply).
 */
function CollapsibleJson({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const json = JSON.stringify(value, null, 2) ?? "null";
  const isLong = json.length > COLLAPSE_THRESHOLD;
  const shown = isLong && !expanded ? json.slice(0, COLLAPSE_THRESHOLD) : json;
  return (
    <div>
      <pre className="overflow-x-auto rounded-md bg-[#0b0b0d] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-300">
        {highlightJson(shown)}
        {isLong && !expanded && "…"}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[10.5px] text-primary hover:opacity-80"
        >
          {expanded ? "Ver menos" : "Ver mais"}
        </button>
      )}
    </div>
  );
}

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

function CopyJsonButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Não foi possível copiar.");
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" /> Copiado
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" /> Copiar
        </>
      )}
    </button>
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
          <p className="mb-1 text-[11px] font-semibold tracking-wide text-red-400 uppercase">
            Erro
          </p>
          <p className="rounded-md bg-red-500/10 p-2 text-xs text-red-300">
            {errorMessage}
          </p>
          {errorStack && (
            <div className="mt-1">
              <CollapsibleJson value={errorStack} />
            </div>
          )}
        </div>
      )}

      {hasInputOutput ? (
        <>
          {"input" in payload && <PayloadSection label="Input" value={payload.input} />}
          {"output" in payload && <PayloadSection label="Output" value={payload.output} />}
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
  if (!ev) {
    return (
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-md" />
      </Sheet>
    );
  }
  const Icon = EVENT_ICON[ev.event_type] ?? ChevronRight;
  const cls = EVENT_COLOR[ev.event_type] ?? "text-muted-foreground";
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
            <Icon className={cn("h-4 w-4 shrink-0", cls)} />
            <span className={cn("font-mono", cls)}>{ev.event_type}</span>
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2 pt-1">
            {ev.node_key && (
              <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {ev.node_type ? `${ev.node_key} (${ev.node_type})` : ev.node_key}
              </code>
            )}
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
          <div className="mb-3 flex justify-end">
            <CopyJsonButton value={ev.payload} />
          </div>
          <EventPayloadBody ev={ev} />
        </div>

        <SheetFooter className="border-t border-border px-5 py-3">
          <span className="text-[11px] text-muted-foreground">
            {format(new Date(ev.created_at), "PPpp")}
          </span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
