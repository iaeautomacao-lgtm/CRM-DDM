"use client";

// Atribuir conversa a quem está em pausa só com confirmação (decisão do
// servidor: POST /transfer devolve 409 agent_paused e é repetido com
// confirm_paused). Sem notificar o atendente: a conversa fica com ele para
// quando voltar.

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useNowMs } from "@/hooks/use-pauses";
import { formatPauseDuration, pauseElapsedSeconds, type PausedAgentInfo } from "@/lib/pausas/pause";

export function PausedAgentConfirm({
  info,
  onConfirm,
  onCancel,
}: {
  info: PausedAgentInfo | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const nowMs = useNowMs(60_000, info !== null);
  const since = info ? formatPauseDuration(pauseElapsedSeconds(info.startedAt, nowMs)) : "";
  return (
    <AlertDialog open={info !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{info?.agentName} está em pausa</AlertDialogTitle>
          <AlertDialogDescription>
            Motivo: {info?.reasonName}, há {since}. Se você atribuir mesmo assim, a conversa fica com{" "}
            {info?.agentName} e só será atendida quando a pessoa voltar.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Escolher outra pessoa</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Atribuir mesmo assim</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
