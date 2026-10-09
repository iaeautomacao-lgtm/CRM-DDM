"use client";

import { AlertTriangle, Clock } from "lucide-react";
import type { ForecastResult } from "@/lib/disparador/dispatch-forecast";

// Previsão de término (passo Configurações e Revisão). Sempre como faixa:
// o ritmo real depende do provedor e de outras campanhas no mesmo cron.

function fmtNumber(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

const WEEKDAY = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "qua, 07/10 14:30" em Brasília (UTC-3 fixo, mesma premissa de send-window.ts). */
export function formatShortBrasilia(date: Date): string {
  const d = new Date(date.getTime() - 3 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAY[d.getUTCDay()]}, ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

interface ForecastSummaryProps {
  forecast: ForecastResult | null;
  /** Por que não há previsão (ex.: público desconhecido). */
  unavailableReason?: string;
  /** Data/hora final escolhida (ISO), para avisar quando a base não termina até lá. */
  endTarget?: string | null;
  compact?: boolean;
}

export function ForecastSummary({ forecast, unavailableReason, endTarget, compact }: ForecastSummaryProps) {
  if (!forecast) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Previsão de término
        </p>
        <p className="mt-1">{unavailableReason ?? "Complete a origem e o agendamento para ver a previsão."}</p>
      </div>
    );
  }
  const sameEnd = forecast.otimista.end.getTime() === forecast.conservador.end.getTime();
  const exceeds = endTarget ? forecast.conservador.end.getTime() > new Date(endTarget).getTime() : false;
  const exceedsAlways = endTarget ? forecast.otimista.end.getTime() > new Date(endTarget).getTime() : false;

  return (
    <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs" aria-live="polite">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <Clock className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> Previsão de término (estimativa)
      </p>
      <p className="text-sm text-foreground">
        {sameEnd ? (
          <>
            por volta de <strong>{formatShortBrasilia(forecast.conservador.end)}</strong>
          </>
        ) : (
          <>
            entre <strong>{formatShortBrasilia(forecast.otimista.end)}</strong> e{" "}
            <strong>{formatShortBrasilia(forecast.conservador.end)}</strong>
          </>
        )}{" "}
        <span className="text-muted-foreground">(Brasília)</span>
      </p>
      {!compact && (
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          <li>
            Primeiro envio: {formatShortBrasilia(forecast.firstSendAt)} · {fmtNumber(forecast.items)} mensage
            {forecast.items === 1 ? "m" : "ns"}
            {forecast.rounds > 1 &&
              ` em ${fmtNumber(forecast.rounds)} rodadas de ${fmtNumber(forecast.contactsPerRound)} contato${forecast.contactsPerRound === 1 ? "" : "s"}`}
            .
          </li>
          <li>
            ≈ {fmtNumber(forecast.ratePerMinute ?? forecast.otimista.perMinute)} envios/min neste número (ritmo medido nas últimas 24 h). Outras campanhas no mesmo número dividem o ritmo.
          </li>
          <li>Feriados não entram na conta.</li>
        </ul>
      )}
      {forecast.roundsOverlap && (
        <p className="flex items-start gap-1.5 text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Cada rodada leva de {forecast.roundDrainMinutes.min} a {forecast.roundDrainMinutes.max} min para sair, mais que o
          intervalo escolhido: as rodadas vão sair uma atrás da outra. Diminua o percentual ou aumente o intervalo.
        </p>
      )}
      {forecast.sequentialFallback && (
        <p className="flex items-start gap-1.5 text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Base pequena: cada rodada tem 1 contato, então sai 1 mensagem por intervalo.
        </p>
      )}
      {exceeds && (
        <p className="flex items-start gap-1.5 text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {exceedsAlways ? "A base não termina" : "A base pode não terminar"} até a data final escolhida. O envio continua
          nos próximos dias úteis, no mesmo horário, até acabar.
        </p>
      )}
    </div>
  );
}
