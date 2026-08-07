"use client";

import { UserCheck } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/dashboard/empty-state";
import { presenceLabel, type PresenceStatus } from "@/lib/presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import type { AccountMember } from "@/types";
import type { MonitorConversation } from "@/lib/monitoramento/queries";
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
}: {
  agent: AccountMember;
  presence: PresenceStatus;
  lastSeenAt: string | null | undefined;
  now: number;
  conversations: MonitorConversation[];
  actions: ConversationCardActions;
}) {
  const displayName = agent.full_name || agent.email || "Sem nome";
  const initials = displayName.charAt(0).toUpperCase();

  const ids = conversations.map((c) => c.id);
  const allSelected = ids.length > 0 && ids.every((id) => actions.selectedIds.has(id));
  const someSelected = ids.some((id) => actions.selectedIds.has(id));

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
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

      {/* TODO(monitoramento): bulk-actions bar goes here once selection
          drives real actions — visual/foundation only for now. */}

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
