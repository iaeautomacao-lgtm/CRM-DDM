"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ArrowLeftRight, Eye, History, MoreVertical, Star, UserRound, XCircle } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import type { MonitorConversation } from "@/lib/monitoramento/queries";
import { PHASE_META, type MonitorPhase } from "@/lib/monitoramento/phases";

export function ConversationCard({
  conversation,
  phase,
  teamName,
  agentName,
  hideTeam = false,
  hideAgent = false,
  selected,
  onToggleSelect,
  onTransferClick,
  onFinalizeClick,
  onHistoryClick,
}: {
  conversation: MonitorConversation;
  phase: MonitorPhase;
  /** Resolved team name, if conversation.team_id is set — the card
   *  doesn't know the team list, the caller (page.tsx) resolves it. */
  teamName?: string | null;
  /** Resolved agent name, if conversation.assigned_agent_id is set. */
  agentName?: string | null;
  /** True inside a team column (Equipes tab) — the team badge would
   *  just repeat the column it's already in. */
  hideTeam?: boolean;
  /** True inside an agent column (Agentes tab) — same reasoning. */
  hideAgent?: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onTransferClick: (conversation: MonitorConversation) => void;
  onFinalizeClick: (conversation: MonitorConversation) => void;
  onHistoryClick: (conversation: MonitorConversation) => void;
}) {
  const { accountId } = useAuth();
  const contact = conversation.contact;
  const displayName = contact?.name?.trim() || contact?.phone || "Desconhecido";
  const initials = displayName.charAt(0).toUpperCase();
  const timeAgo = formatDistanceToNow(new Date(conversation.updated_at), {
    addSuffix: true,
    locale: ptBR,
  });
  const meta = PHASE_META[phase];
  const PhaseIcon = meta.icon;

  const showTeamBadge = !hideTeam && !!teamName;
  const showAgentBadge = !hideAgent && !!agentName;
  // "Sem atendimento" reflects the conversation's REAL state (no team
  // AND no agent), independent of which tab is hiding which badge —
  // hiding the team badge inside the Equipes tab doesn't mean the
  // conversation has no agent, so it must not trigger this fallback.
  const showUnstaffed = !conversation.team_id && !conversation.assigned_agent_id;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-border bg-card p-3 transition-colors",
        selected && "border-primary/50 bg-primary/5",
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggleSelect(conversation.id)}
        aria-label={`Selecionar conversa com ${displayName}`}
        className="mt-1"
      />

      <Link
        href={`/inbox?c=${conversation.id}`}
        className="flex min-w-0 flex-1 items-center gap-3 hover:opacity-90"
      >
        <Avatar>
          {contact?.avatar_url ? (
            <AvatarImage
              src={contact.avatar_url && accountId ? `/api/whatsapp/contacts/avatar?phone=${encodeURIComponent((contact.phone ?? "").replace(/^\+/, "").replace(/\s/g, ""))}&account_id=${accountId}` : contact.avatar_url ?? ""}
              alt={displayName}
            />
          ) : null}
          <AvatarFallback className="bg-primary/10 font-medium text-primary">
            {initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
          <p className="text-xs text-muted-foreground">{timeAgo}</p>

          {/* Fase é sempre visível, mesmo redundante dentro da própria
              coluna de fase — mesmo comportamento da Fortics. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                meta.badgeClass,
              )}
            >
              <PhaseIcon className="size-3" />
              {meta.label}
            </span>

            {showTeamBadge && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <Star className="size-3" />
                {teamName}
              </span>
            )}

            {showAgentBadge && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <UserRound className="size-3" />
                {agentName}
              </span>
            )}

            {showUnstaffed && (
              <span className="text-[11px] text-muted-foreground">Contato sem atendimento</span>
            )}
          </div>
        </div>
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Mais ações"
        >
          <MoreVertical className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px] bg-popover text-popover-foreground">
          <DropdownMenuItem
            render={<Link href={`/inbox?c=${conversation.id}`} />}
            className="whitespace-nowrap text-popover-foreground"
          >
            <Eye className="size-4" />
            Ver conversa
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onHistoryClick(conversation)}
            className="whitespace-nowrap text-popover-foreground"
          >
            <History className="size-4" />
            Ver histórico
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={() => onTransferClick(conversation)}
            className="whitespace-nowrap text-popover-foreground"
          >
            <ArrowLeftRight className="size-4" />
            Transferir para…
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={() => onFinalizeClick(conversation)}
            className="whitespace-nowrap text-red-500 focus:bg-red-50 focus:text-red-500"
          >
            <XCircle className="size-4" />
            Finalizar atendimento
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
