"use client";

// Selo de espera do cartão do Monitoramento: "aguarda 12 min", em atraso (amarelo) ou crítico (vermelho) conforme o SLA
// de primeira resposta da equipe da conversa. Mesma regra e mesmas cores da lista do Inbox. Memoizado e com o próprio
// relógio compartilhado: o cartão (também memoizado) recebe só números e não renderiza a cada tick.

import { memo } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSharedClock } from "@/hooks/use-shared-clock";
import { formatWait } from "@/lib/inbox/wait-time";
import { cardWait } from "@/lib/monitoramento/card-wait";

const LEVEL_CLASS = {
  ok: "bg-muted text-foreground-2",
  late: "bg-warning/10 text-warning",
  critical: "bg-destructive/10 text-destructive",
} as const;

const LEVEL_LABEL = {
  ok: "no prazo",
  late: "atrasado",
  critical: "crítico",
} as const;

export const WaitBadge = memo(function WaitBadge({ sinceMs, slaLimitMin }: { sinceMs: number; slaLimitMin: number }) {
  const nowMs = useSharedClock();
  const { minutes, level } = cardWait(sinceMs, nowMs, slaLimitMin);
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums", LEVEL_CLASS[level])}
      title={`Cliente aguardando resposta há ${formatWait(minutes)} · SLA da equipe: ${slaLimitMin} min · ${LEVEL_LABEL[level]}`}
    >
      <Clock className="size-3" aria-hidden="true" />
      aguarda {formatWait(minutes)}
      <span className="sr-only"> ({LEVEL_LABEL[level]}, SLA de {slaLimitMin} minutos)</span>
    </span>
  );
});
