"use client";

import { cn } from "@/lib/utils";

/** Indicador "ao vivo" do acompanhamento do Disparador: canal assinado (empurrado pelo banco) ou consulta periódica. */
export function LiveBadge({ connected, latencyMs, className }: { connected: boolean; latencyMs?: number | null; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground", className)}
      title={connected ? "Atualizando em tempo real: cada envio aparece na hora; a tela confere o total a cada 45 s." : "Canal ao vivo indisponível: atualizando a cada 3 s."}
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", connected ? "animate-pulse bg-success" : "bg-muted-foreground")} />
      {connected ? `Ao vivo${latencyMs != null ? ` · ${latencyMs} ms` : ""}` : "Atualizando a cada 3 s"}
    </span>
  );
}
