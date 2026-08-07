"use client";

import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { MonitorConversation } from "@/lib/monitoramento/queries";
import { PHASE_META, type MonitorPhase } from "@/lib/monitoramento/phases";
import { ConversationCard } from "./conversation-card";
import type { ConversationCardActions } from "./card-actions";

// Display cap per column — no pagination in this first slice. Lists are
// already sorted newest-updated-first by the query, so this simply
// hides the tail past the cap rather than dropping the most relevant
// (most recently touched) conversations.
// TODO(monitoramento): replace with real pagination/virtualization once
// a column routinely exceeds this in practice.
const COLUMN_DISPLAY_LIMIT = 100;

export function PhaseColumn({
  phase,
  conversations,
  loading,
  actions,
}: {
  phase: MonitorPhase;
  conversations: MonitorConversation[];
  loading: boolean;
  actions: ConversationCardActions;
}) {
  const meta = PHASE_META[phase];
  const Icon = meta.icon;
  const visible = conversations.slice(0, COLUMN_DISPLAY_LIMIT);

  const visibleIds = visible.map((c) => c.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => actions.selectedIds.has(id));
  const someSelected = visibleIds.some((id) => actions.selectedIds.has(id));

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full",
            meta.badgeClass,
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-semibold text-foreground">{meta.label}</h2>
        {visibleIds.length > 0 && (
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected && !allSelected}
            onCheckedChange={() => actions.onToggleSelectAll(visibleIds, !allSelected)}
            aria-label={`Selecionar todas as conversas em ${meta.label}`}
          />
        )}
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {conversations.length}
        </span>
      </header>

      {/* TODO(monitoramento): bulk-actions bar goes here (e.g. "3
          selecionadas — Transferir / Finalizar") once selection drives
          real actions — for now it's visual/foundation only. */}

      <div className="flex-1 space-y-2 overflow-y-auto p-3" style={{ maxHeight: "70vh" }}>
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))
        ) : visible.length === 0 ? (
          <EmptyState icon={Icon} title={meta.emptyTitle} hint={meta.emptyHint} className="h-full" />
        ) : (
          visible.map((c) => (
            <ConversationCard
              key={c.id}
              conversation={c}
              phase={phase}
              teamName={actions.getTeamName(c.team_id)}
              agentName={actions.getAgentName(c.assigned_agent_id)}
              selected={actions.selectedIds.has(c.id)}
              onToggleSelect={actions.onToggleSelect}
              onTransferClick={actions.onTransferClick}
              onFinalizeClick={actions.onFinalizeClick}
              onHistoryClick={actions.onHistoryClick}
            />
          ))
        )}
      </div>
    </section>
  );
}
