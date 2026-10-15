"use client";

// Faixa do topo do Inbox: o atendente escolhe o motivo e pausa; em pausa,
// vê o cronômetro, o aviso de estouro e o botão de voltar. Pausado, ele não
// recebe conversa nova (a regra mora na distribuição do servidor) e mantém
// as que já tem.

import { Coffee, Loader2, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useMyPause, useNowMs } from "@/hooks/use-pauses";
import { formatClock, pauseElapsedSeconds, pauseErrorMessage, pauseLevel } from "@/lib/pausas/pause";

export function MyPauseBar() {
  const { enabled, loaded, pause, reasons, busy, start, resume } = useMyPause();
  const now = useNowMs(1000, !!pause);

  if (!enabled || !loaded) return null;

  async function handleStart(reasonId: string) {
    const err = await start(reasonId);
    if (err && err.code !== "already_paused") toast.error(pauseErrorMessage(err.code, err.message));
  }

  async function handleResume() {
    const err = await resume();
    if (err) toast.error(pauseErrorMessage(err.code, err.code === "paused_by_supervisor" ? `Esta pausa foi aplicada por ${err.startedByName ?? "um supervisor"}; só um supervisor pode retomar.` : err.message));
    else toast.success("Você voltou ao atendimento");
  }

  if (!pause) {
    return (
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border bg-card px-3.5">
        <span className="inline-flex items-center gap-1.5 text-xs text-foreground-2">
          <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
          Disponível para novas conversas
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy || reasons.length === 0}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-semibold text-foreground hover:bg-surface-hover disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Coffee className="size-3.5" aria-hidden="true" />}
            Pausar
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Motivo da pausa. Você não recebe conversas novas, mas mantém as suas.
            </DropdownMenuLabel>
            {reasons.map((r) => (
              <DropdownMenuItem key={r.id} onClick={() => void handleStart(r.id)} className="justify-between gap-4 text-[13px]">
                {r.name}
                {r.max_minutes !== null && <span className="text-xs text-muted-foreground">até {r.max_minutes} min</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const elapsed = pauseElapsedSeconds(pause.started_at, now);
  const level = pauseLevel(elapsed, pause.max_minutes);
  const lockedBySupervisor = pause.by_supervisor;

  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3.5 py-2",
        level === "critical"
          ? "border-danger/30 bg-danger-soft"
          : level === "late"
            ? "border-warning/30 bg-warning-soft"
            : "border-border bg-card-2",
      )}
    >
      <Coffee
        className={cn("size-4 shrink-0", level === "critical" ? "text-danger" : level === "late" ? "text-warning" : "text-foreground-2")}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 text-[13px] text-foreground">
        <span className="font-semibold">Em pausa: {pause.reason_name}</span>
        {lockedBySupervisor && pause.started_by_name && <span className="text-foreground-2"> · pausado por {pause.started_by_name}</span>}
        {level !== "ok" && pause.max_minutes !== null ? (
          <span className="block text-xs">
            {level === "critical" ? "Muito acima do tempo" : "Passou do tempo"} deste motivo ({pause.max_minutes} min). Volte ao atendimento.
          </span>
        ) : (
          <span className="block text-xs text-foreground-2">
            Você não recebe conversas novas; as suas continuam com você.
          </span>
        )}
      </div>
      <span className="font-mono text-sm font-semibold tabular-nums text-foreground" aria-label="Tempo em pausa">
        {formatClock(elapsed)}
        {pause.max_minutes !== null && <span className="font-normal text-muted-foreground"> / {pause.max_minutes} min</span>}
      </span>
      {lockedBySupervisor ? (
        <span className="text-xs text-foreground-2">Só um supervisor pode retomar.</span>
      ) : (
        <Button size="sm" onClick={() => void handleResume()} disabled={busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <PlayCircle className="size-3.5" aria-hidden="true" />}
          Voltar ao atendimento
        </Button>
      )}
    </div>
  );
}
