"use client";

import type { ReactNode } from "react";
import type { AiAnalyticsData } from "@/lib/dashboard/types";

interface AiPerformanceProps {
  data: AiAnalyticsData | null;
  loading: boolean;
}

export function AiPerformance({ data, loading }: AiPerformanceProps) {
  if (loading || !data) {
    return (
      <div className="grid animate-pulse grid-cols-1 gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border/80 bg-card/25 p-4">
            <div className="h-3 w-20 rounded bg-muted" />
            <div className="mt-4 h-7 w-16 rounded bg-muted" />
            <div className="mt-5 h-20 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  const { sentiment, messagesRatio, conversion } = data;
  const totalSentiment = sentiment.total || 1;
  const pctPositive = Math.round((sentiment.positive / totalSentiment) * 100);
  const pctNeutral = Math.round((sentiment.neutral / totalSentiment) * 100);
  const pctNegative = Math.round((sentiment.negative / totalSentiment) * 100);
  const pctMixed = Math.round((sentiment.mixed / totalSentiment) * 100);

  const totalOutbound = messagesRatio.total || 1;
  const pctBot = Math.round((messagesRatio.bot / totalOutbound) * 100);
  const pctHuman = Math.round((messagesRatio.human / totalOutbound) * 100);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <MetricColumn eyebrow="Sentimento" value={pctPositive + "%"} description="positivo">
        <BreakdownRow label="Positivo" value={sentiment.positive + " (" + pctPositive + "%)"} percent={pctPositive} tone="success" />
        <BreakdownRow label="Neutro" value={sentiment.neutral + " (" + pctNeutral + "%)"} percent={pctNeutral} />
        <BreakdownRow label="Negativo" value={sentiment.negative + " (" + pctNegative + "%)"} percent={pctNegative} tone="danger" />
        {sentiment.mixed > 0 ? (
          <BreakdownRow label="Misto" value={sentiment.mixed + " (" + pctMixed + "%)"} percent={pctMixed} tone="warning" />
        ) : null}
      </MetricColumn>

      <MetricColumn eyebrow="Automação" value={pctBot + "%"} description="pela IA">
        <BreakdownRow label="IA" value={messagesRatio.bot.toLocaleString("pt-BR")} percent={pctBot} />
        <BreakdownRow label="Humano" value={messagesRatio.human.toLocaleString("pt-BR")} percent={pctHuman} />
      </MetricColumn>

      <MetricColumn eyebrow="Conversão" value={conversion.rate + "%"} description="fechamento">
        <SimpleRow label="Ganhos" value={conversion.won} tone="success" />
        <SimpleRow label="Perdidos" value={conversion.lost} tone="danger" />
        <SimpleRow label="Em aberto" value={conversion.open} />
      </MetricColumn>
    </div>
  );
}

function MetricColumn({
  eyebrow,
  value,
  description,
  children,
}: {
  eyebrow: string;
  value: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/80 bg-card/25 p-4">
      <p className="text-xs font-medium text-muted-foreground">{eyebrow}</p>

      <div className="mt-3 flex items-end gap-2">
        <strong className="text-[28px] font-semibold leading-none tracking-[-0.035em] tabular-nums text-foreground">
          {value}
        </strong>
        <span className="pb-0.5 text-[11px] text-muted-foreground">{description}</span>
      </div>

      <div className="mt-5 space-y-3">{children}</div>
    </section>
  );
}

function BreakdownRow({
  label,
  value,
  percent,
  tone = "neutral",
}: {
  label: string;
  value: string;
  percent: number;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const barClass =
    tone === "success"
      ? "bg-emerald-500"
      : tone === "warning"
        ? "bg-amber-500"
        : tone === "danger"
          ? "bg-rose-500"
          : "bg-primary";

  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums text-foreground">{value}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={"h-full rounded-full " + barClass}
          style={{ width: String(Math.max(0, Math.min(100, percent))) + "%" }}
        />
      </div>
    </div>
  );
}

function SimpleRow({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-500"
      : tone === "danger"
        ? "text-rose-500"
        : "text-foreground";

  return (
    <div className="flex items-center justify-between border-b border-border/70 pb-2.5 text-xs last:border-b-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={"font-semibold tabular-nums " + toneClass}>
        {value.toLocaleString("pt-BR")}
      </span>
    </div>
  );
}
