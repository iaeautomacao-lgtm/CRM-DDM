"use client";

import { UserCheck } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/dashboard/empty-state";
import { presenceLabel, type PresenceStatus } from "@/lib/presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import type { AccountMember } from "@/types";
import type { MonitorConversation } from "@/lib/monitoramento/queries";
import { formatFirstResponse, type AgentMetrics } from "@/lib/monitoramento/agent-metrics";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationCard } from "./conversation-card";
import type { ConversationCardActions } from "./card-actions";

const PRESENCE_TEXT: Record<PresenceStatus, string> = {
  online: "Online",
  away: "Ausente",
  offline: "Offline",
};

export function AgentColumn({
  agent,
  presence,
  lastSeenAt,
  now,
  conversations,
  actions,
  metrics,
  metricsLoading = false,
  metricsUnavailable = false,
  metricsPeriodLabel,
}: {
  agent: AccountMember;
  presence: PresenceStatus;
  lastSeenAt: string | null | undefined;
  now: number;
  conversations: MonitorConversation[];
  actions: ConversationCardActions;
  /** Métricas do período (GET /api/monitoramento/agentes). Ausente com a lista já carregada = nenhuma no período. */
  metrics?: AgentMetrics;
  metricsLoading?: boolean;
  /** A busca falhou: mostra "—" em vez de zero. */
  metricsUnavailable?: boolean;
  /** "hoje" ou "nos últimos 7 dias": entra no rótulo do cartão. */
  metricsPeriodLabel?: string;
}) {
  const displayName = agent.full_name || agent.email || "Sem nome";
  const initials = displayName.charAt(0).toUpperCase();

  const ids = conversations.map((c) => c.id);
  const allSelected = ids.length > 0 && ids.every((id) => actions.selectedIds.has(id));
  const someSelected = ids.some((id) => actions.selectedIds.has(id));

  return (
    <section className="flex min-h-0 flex-col rounded-[10px] border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="relative shrink-0">
          <Avatar>
            {agent.avatar_url ? <AvatarImage src={agent.avatar_url} alt={displayName} /> : null}
            <AvatarFallback className="bg-primary/10 font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <PresenceDot
            status={presence}
            label={presenceLabel(presence, lastSeenAt, now)}
            className="absolute -right-0.5 -bottom-0.5 ring-2 ring-card"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
          <p className="text-xs text-muted-foreground">{PRESENCE_TEXT[presence]}</p>
        </div>
        {ids.length > 0 && (
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected && !allSelected}
            onCheckedChange={() => actions.onToggleSelectAll(ids, !allSelected)}
            aria-label={`Selecionar todas as conversas de ${displayName}`}
          />
        )}
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {conversations.length}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-2 px-3 pt-3">
        <div className="rounded-md bg-surface-3/60 px-2.5 py-2">
          <dt className="text-[11.5px] text-muted-foreground">1ª resposta (média)</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {metricsLoading ? <Skeleton className="h-4 w-12" /> : formatFirstResponse(metrics?.first_response_avg_seconds)}
          </dd>
        </div>
        <div className="rounded-md bg-surface-3/60 px-2.5 py-2">
          <dt className="text-[11.5px] text-muted-foreground">Resolvidas {metricsPeriodLabel}</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {metricsLoading ? <Skeleton className="h-4 w-8" /> : metricsUnavailable ? "—" : (metrics?.resolved_count ?? 0).toLocaleString("pt-BR")}
          </dd>
        </div>
      </dl>

      <div className="flex-1 space-y-2 overflow-y-auto p-3" style={{ maxHeight: "70vh" }}>
        {conversations.length === 0 ? (
          <EmptyState
            icon={UserCheck}
            title="Nenhum contato em atendimento com este agente"
            className="h-full"
          />
        ) : (
          conversations.map((c) => (
            // Every conversation reaching this view has an assigned
            // agent by construction, so it's always "atendimento" —
            // classifyPhase would agree, this just skips recomputing it.
            <ConversationCard
              key={c.id}
              conversation={c}
              phase="atendimento"
              teamName={actions.getTeamName(c.team_id)}
              hideAgent
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
