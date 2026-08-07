"use client";

// ============================================================
// AgentDragCard — compact agent card for the "Equipes" tab's Agentes
// section. Same avatar+presence-dot look as agent-column.tsx's column
// header (not imported from there — that component is a whole column
// for the "Agentes" tab, a different shape; this is one row in a
// list), wrapped in dnd-kit's useDraggable so it can move between team
// columns.
//
// `draggable=false` renders the same look with no drag wiring at all
// — used both for viewers who can't drag (item 4's admin/owner-only
// rule: dnd-kit never even starts a drag on a disabled draggable, so
// there's nothing to "fail" — it's just not grabbable) and for the
// static snapshot inside <DragOverlay>.
// ============================================================

import { useDraggable } from "@dnd-kit/core";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel, type PresenceStatus } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { AccountMember } from "@/types";

const PRESENCE_TEXT: Record<PresenceStatus, string> = {
  online: "Online",
  away: "Ausente",
  offline: "Offline",
};

export function AgentDragCard({
  agent,
  presence,
  lastSeenAt,
  now,
  draggable,
}: {
  agent: AccountMember;
  presence: PresenceStatus;
  lastSeenAt: string | null | undefined;
  now: number;
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: agent.user_id,
    disabled: !draggable,
  });

  const displayName = agent.full_name || agent.email || "Sem nome";
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div
      ref={setNodeRef}
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
      style={{
        opacity: isDragging ? 0.3 : 1,
        touchAction: draggable ? "none" : undefined,
      }}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border border-border bg-card p-2",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
    >
      <div className="relative shrink-0">
        <Avatar size="sm">
          {agent.avatar_url ? (
            <AvatarImage src={agent.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
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
        <p className="truncate text-xs font-medium text-foreground">{displayName}</p>
        <p className="text-[11px] text-muted-foreground">{PRESENCE_TEXT[presence]}</p>
      </div>
    </div>
  );
}
