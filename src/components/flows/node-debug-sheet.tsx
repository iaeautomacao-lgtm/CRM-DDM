"use client";

/**
 * Debug-mode side panel — opens when a node is clicked while
 * `?run_id=` is active (see flow-canvas.tsx's `debug` prop). Shows
 * that node_key's events from the run instead of the normal
 * NodeConfigForm edit sheet; "Editar nó" exits debug mode and hands
 * back to the caller so it can reopen the normal edit sheet for the
 * same node.
 *
 * The payload rendering (dark/mono/syntax-highlighted JSON) uses the
 * shared `JsonHighlight` (./json-highlight) so it stays visually
 * identical to `runs/page.tsx`'s event detail sheet.
 */

import {
  CheckCircle,
  CheckCircle2,
  Circle,
  ChevronRight,
  MessageCircle,
  MessageSquare,
  Pencil,
  Play,
  XCircle,
} from "lucide-react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { FlowDebugEvent } from "@/hooks/use-flow-debug";
import { NODE_META, NodeIconChip, nodeColors, type NodeType } from "./shared";
import { JsonHighlight } from "./json-highlight";

const EVENT_ICON: Record<string, typeof Circle> = {
  started: Play,
  run_started: Play,
  node_entered: ChevronRight,
  node_completed: CheckCircle,
  message_sent: MessageCircle,
  reply_received: MessageSquare,
  completed: CheckCircle,
  run_completed: CheckCircle2,
  node_error: XCircle,
  run_error: XCircle,
};

function getEventIcon(ev: FlowDebugEvent): typeof Circle {
  return EVENT_ICON[ev.event_type] ?? Circle;
}

function getEventColor(ev: FlowDebugEvent): string {
  if (ev.event_type === "node_error" || ev.event_type === "run_error") {
    return "text-red-400";
  }
  if (
    ev.event_type === "node_completed" ||
    ev.event_type === "run_completed" ||
    ev.event_type === "completed"
  ) {
    return "text-emerald-400";
  }
  if (ev.event_type === "message_sent") return "text-blue-400";
  if (ev.event_type === "reply_received") return "text-sky-300";
  return "text-muted-foreground";
}

function EventPayloadPreview({ value }: { value: Record<string, unknown> }) {
  if (Object.keys(value).length === 0) return null;
  return (
    <JsonHighlight
      value={JSON.stringify(value, null, 2)}
      className="p-2 text-[10.5px]"
    />
  );
}

export function NodeDebugEventsSheet({
  nodeKey,
  nodeType,
  events,
  onClose,
  onEditNode,
}: {
  nodeKey: string | null;
  nodeType: NodeType | null;
  events: FlowDebugEvent[];
  onClose: () => void;
  onEditNode: () => void;
}) {
  const open = nodeKey !== null;
  if (!nodeKey) {
    return (
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-md" />
      </Sheet>
    );
  }
  const meta = nodeType ? NODE_META[nodeType] : null;
  const c = nodeType ? nodeColors(nodeType) : null;
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="border-border bg-popover flex w-full flex-col gap-0 border-l p-0 sm:max-w-md"
      >
        <SheetHeader className="border-border flex-row items-center gap-3 space-y-0 border-b px-5 py-4">
          {nodeType && (
            <NodeIconChip type={nodeType} size={36} iconSize={18} />
          )}
          <div className="min-w-0 flex-1">
            <SheetTitle
              className="text-[11px] font-semibold tracking-wider uppercase"
              style={c ? { color: c.text } : undefined}
            >
              {meta?.label ?? nodeType ?? "Nó"}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground mt-0.5 text-xs">
              {events.length} {events.length === 1 ? "evento" : "eventos"} nesta
              execução
            </SheetDescription>
          </div>
          <code className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
            {nodeKey}
          </code>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {events.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Este nó não foi alcançado nesta execução.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {events.map((ev, ix) => {
                const Icon = getEventIcon(ev);
                const cls = getEventColor(ev);
                return (
                  <div
                    key={ix}
                    className="border-border rounded-md border p-2.5"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <Icon className={cn("h-3.5 w-3.5 shrink-0", cls)} />
                      <span className={cn("font-mono text-[11px]", cls)}>
                        {ev.event_type}
                      </span>
                      {typeof ev.duration_ms === "number" && (
                        <span className="text-muted-foreground text-[10px]">
                          {ev.duration_ms}ms
                        </span>
                      )}
                      <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                        {format(new Date(ev.created_at), "HH:mm:ss")}
                      </span>
                    </div>
                    {ev.error_message && (
                      <p className="mt-1 text-[11px] text-red-300">
                        {ev.error_message}
                      </p>
                    )}
                    {ev.payload && (
                      <div className="mt-1.5">
                        <EventPayloadPreview value={ev.payload} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <SheetFooter className="border-border border-t px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onEditNode}
            className="w-full"
          >
            <Pencil className="h-3.5 w-3.5" />
            Editar nó
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
