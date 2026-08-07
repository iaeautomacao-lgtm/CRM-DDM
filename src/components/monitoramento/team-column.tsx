"use client";

import { useDroppable } from "@dnd-kit/core";
import { Pencil, Users } from "lucide-react";
import { RequireRole } from "@/components/auth/require-role";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/dashboard/empty-state";
import { classifyPhase } from "@/lib/monitoramento/phases";
import type { MonitorConversation } from "@/lib/monitoramento/queries";
import type { PresenceStatus } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { AccountMember, Team } from "@/types";
import { AgentDragCard } from "./agent-drag-card";
import { ConversationCard } from "./conversation-card";
import type { ConversationCardActions } from "./card-actions";

export function TeamColumn({
  team,
  overflowTeamName,
  agents,
  conversations,
  getPresence,
  getLastSeenAt,
  now,
  canDrag,
  onEdit,
  actions,
}: {
  team: Team;
  /** Resolved display name of team.overflow_team_id, if set — the
   *  column only knows the id, the page resolves the name once from
   *  the already-loaded team list. */
  overflowTeamName: string | null;
  /** Members of this team (profiles.team_id === team.id). */
  agents: AccountMember[];
  conversations: MonitorConversation[];
  getPresence: (userId: string) => PresenceStatus;
  getLastSeenAt: (userId: string) => string | null | undefined;
  now: number;
  /** Admin+ only — set_member_team enforces this server-side too;
   *  this just decides whether the agent cards below are grabbable. */
  canDrag: boolean;
  /** Opens the shared TeamFormDialog (owned by the page) pre-filled
   *  with this column's team — same component the "Nova equipe" /
   *  "Criar primeira equipe" buttons open with team=null. */
  onEdit: (team: Team) => void;
  actions: ConversationCardActions;
}) {
  // Droppable ref sits on the agent section specifically (not the
  // whole column) — same reasoning as pipeline-board.tsx's
  // StageColumn: a drag over the header shouldn't highlight the
  // entire column.
  const { setNodeRef, isOver } = useDroppable({ id: team.id });

  const hasBadges = team.session_timeout_minutes != null || !!overflowTeamName;

  const conversationIds = conversations.map((c) => c.id);
  const allSelected =
    conversationIds.length > 0 && conversationIds.every((id) => actions.selectedIds.has(id));
  const someSelected = conversationIds.some((id) => actions.selectedIds.has(id));

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Users className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{team.name}</h2>
          {hasBadges && (
            <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-[11px] text-muted-foreground">
              {team.session_timeout_minutes != null ? (
                <span>Sessão: {team.session_timeout_minutes}min</span>
              ) : null}
              {overflowTeamName ? <span>Transbordo: {overflowTeamName}</span> : null}
            </div>
          )}
        </div>
        <RequireRole min="admin">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(team)}
            title="Editar equipe"
            aria-label="Editar equipe"
          >
            <Pencil className="size-4" />
          </Button>
        </RequireRole>
        {conversationIds.length > 0 && (
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected && !allSelected}
            onCheckedChange={() => actions.onToggleSelectAll(conversationIds, !allSelected)}
            aria-label={`Selecionar todas as conversas da equipe ${team.name}`}
          />
        )}
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {conversations.length}
        </span>
      </header>

      <div className="border-b border-border px-3 pt-3 pb-1.5">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Agentes {agents.length > 0 ? `(${agents.length})` : ""}
        </h3>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "space-y-2 p-3 transition-colors",
          isOver && "bg-primary/5 outline outline-2 outline-dashed outline-primary outline-offset-2",
        )}
      >
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {canDrag ? "Arraste um agente aqui." : "Nenhum agente nesta equipe."}
          </p>
        ) : (
          agents.map((agent) => (
            <AgentDragCard
              key={agent.user_id}
              agent={agent}
              presence={getPresence(agent.user_id)}
              lastSeenAt={getLastSeenAt(agent.user_id)}
              now={now}
              draggable={canDrag}
            />
          ))
        )}
      </div>

      <div className="border-t border-b border-border px-3 pt-3 pb-1.5">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Conversas
        </h3>
      </div>
      {/* TODO(monitoramento): bulk-actions bar goes here once selection
          drives real actions — visual/foundation only for now. */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3" style={{ maxHeight: "45vh" }}>
        {conversations.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nenhuma conversa nesta equipe"
            hint="Conversas roteadas para esta equipe aparecem aqui."
            className="h-full"
          />
        ) : (
          conversations.map((c) => (
            <ConversationCard
              key={c.id}
              conversation={c}
              phase={classifyPhase(c.status, c.assigned_agent_id)}
              agentName={actions.getAgentName(c.assigned_agent_id)}
              hideTeam
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
