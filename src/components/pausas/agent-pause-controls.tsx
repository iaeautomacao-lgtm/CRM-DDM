"use client";

// Pausa de um atendente vista pelo supervisor (Monitoramento): selo com o
// motivo e o tempo (âmbar ao passar do limite, vermelho no dobro) e o menu
// para pausar/retomar. O servidor decide quem pode pausar quem (equipe
// própria; admin/owner qualquer um); aqui só se mostra o menu a quem tem a
// permissão e se traduz o erro.

import { Coffee, MoreVertical, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { pausasApi } from "@/lib/pausas/client";
import {
  formatPauseDuration,
  pauseElapsedSeconds,
  pauseErrorMessage,
  pauseLevel,
  type PauseReason,
  type TeamPause,
} from "@/lib/pausas/pause";

export function AgentPauseBadge({ pause, nowMs, className }: { pause: TeamPause; nowMs: number; className?: string }) {
  const elapsed = pauseElapsedSeconds(pause.started_at, nowMs);
  const level = pauseLevel(elapsed, pause.max_minutes);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        level === "critical"
          ? "bg-danger-soft text-danger"
          : level === "late"
            ? "bg-warning-soft text-warning"
            : "bg-surface-3 text-foreground-2",
        className,
      )}
      title={
        (pause.by_supervisor && pause.started_by_name ? `Pausado por ${pause.started_by_name}. ` : "") +
        (pause.max_minutes !== null ? `Limite do motivo: ${pause.max_minutes} min.` : "Sem limite de tempo.")
      }
    >
      <Coffee className="size-3" aria-hidden="true" />
      Pausa: {pause.reason_name} · {formatPauseDuration(elapsed)}
      {level !== "ok" && <span className="sr-only"> (passou do tempo)</span>}
    </span>
  );
}

export function AgentPauseMenu({
  agentId,
  agentName,
  pause,
  reasons,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  pause: TeamPause | undefined;
  reasons: PauseReason[];
  /** Depois de pausar/retomar com sucesso (para reler a lista). */
  onChanged: () => void;
}) {
  async function pauseWith(reason: PauseReason) {
    const res = await pausasApi.start(reason.id, agentId);
    if (res.ok) {
      toast.success(`${agentName} está em pausa (${reason.name})`);
      onChanged();
    } else {
      toast.error(pauseErrorMessage(res.error.code, res.error.message));
      if (res.error.code === "already_paused") onChanged();
    }
  }

  async function resume() {
    const res = await pausasApi.resume(agentId);
    if (res.ok) {
      toast.success(`${agentName} voltou ao atendimento`);
      onChanged();
    } else {
      toast.error(pauseErrorMessage(res.error.code, res.error.message));
      if (res.error.code === "not_paused") onChanged();
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Pausas de ${agentName}`}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <MoreVertical className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        {pause ? (
          <DropdownMenuItem onClick={() => void resume()} className="text-[13px]">
            <PlayCircle className="size-4" aria-hidden="true" />
            Retomar atendimento
          </DropdownMenuItem>
        ) : reasons.length === 0 ? (
          <DropdownMenuLabel className="text-xs text-muted-foreground">Nenhum motivo de pausa ativo.</DropdownMenuLabel>
        ) : (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Pausar {agentName} por…</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {reasons.map((r) => (
              <DropdownMenuItem key={r.id} onClick={() => void pauseWith(r)} className="justify-between gap-4 text-[13px]">
                {r.name}
                {r.max_minutes !== null && <span className="text-xs text-muted-foreground">até {r.max_minutes} min</span>}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
