"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { CountUp } from "@/components/motion/count-up";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

/**
 * Weighted pipeline value: value × per-stage probability.
 * First stage ≈ 10%, stages interpolate up to 90% before the final stage,
 * final stage (Won) = 100%. Lost deals excluded.
 */
function computeStageProbability(
  stage: PipelineStage,
  sortedStages: PipelineStage[],
): number {
  const n = sortedStages.length;
  if (n <= 1) return 1;
  const index = sortedStages.findIndex((s) => s.id === stage.id);
  if (index < 0) return 0;
  if (index === n - 1) return 1;
  const slots = n - 1;
  if (slots <= 1) return 0.1;
  const t = index / (slots - 1);
  return 0.1 + t * (0.9 - 0.1);
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const { defaultCurrency } = useAuth();
  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const stats = useMemo(() => {
    const active = deals.filter((d) => d.status !== "lost");
    const openDeals = active.filter((d) => d.status !== "won");

    const totalCount = active.length;
    const totalValue = active.reduce((sum, d) => sum + Number(d.value || 0), 0);
    const avgValue = totalCount > 0 ? totalValue / totalCount : 0;

    const stageById = new Map(sortedStages.map((s) => [s.id, s]));
    const weightedValue = openDeals.reduce((sum, d) => {
      const stage = stageById.get(d.stage_id);
      if (!stage) return sum;
      const prob = computeStageProbability(stage, sortedStages);
      return sum + Number(d.value || 0) * prob;
    }, 0);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = (d: Deal) => {
      const ts = d.updated_at ?? d.created_at;
      return ts ? new Date(ts) >= monthStart : false;
    };
    const wonThisMonth = deals.filter(
      (d) => d.status === "won" && thisMonth(d),
    ).length;
    const lostThisMonth = deals.filter(
      (d) => d.status === "lost" && thisMonth(d),
    ).length;

    return {
      totalCount,
      totalValue,
      avgValue,
      weightedValue,
      wonThisMonth,
      lostThisMonth,
    };
  }, [deals, sortedStages]);

  return (
    <TooltipProvider>
      {/* Faixa de indicadores (redesenho DDM): células unidas por 1px. */}
      <section
        aria-label="Indicadores do pipeline"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border sm:grid-cols-3 xl:grid-cols-6"
      >
        <Metric
          label="Total de negócios"
          value={stats.totalCount}
          format={(n) => Math.round(n).toLocaleString("pt-BR")}
          tooltip="Contagem de todos os negócios neste pipeline que não estão marcados como Perdido. Negócios Ganhos ainda são incluídos."
        />
        <Metric
          label="Valor do pipeline"
          value={stats.totalValue}
          format={(n) => formatCurrency(n, defaultCurrency)}
          tooltip="Soma dos valores de todos os negócios neste pipeline, excluindo os marcados como Perdido."
        />
        <Metric
          label="Ticket médio"
          value={stats.avgValue}
          format={(n) => formatCurrency(n, defaultCurrency)}
          tooltip="Valor do Pipeline dividido pelo Total de Negócios — o valor médio de um único negócio não perdido."
        />
        <Metric
          label="Valor ponderado"
          value={stats.weightedValue}
          format={(n) => formatCurrency(n, defaultCurrency)}
          tooltip="Receita esperada: valor de cada negócio aberto × probabilidade da etapa. Primeira etapa ≈ 10%, etapas progridem até 90%, Ganho = 100%. Negócios Perdidos são excluídos."
        />
        <Metric
          label="Ganhos no mês"
          value={stats.wonThisMonth}
          format={(n) => Math.round(n).toLocaleString("pt-BR")}
          valueClassName="text-success"
          tooltip="Negócios marcados como Ganho desde o primeiro dia do mês atual."
        />
        <Metric
          label="Perdidos no mês"
          value={stats.lostThisMonth}
          format={(n) => Math.round(n).toLocaleString("pt-BR")}
          valueClassName="text-danger"
          tooltip="Negócios marcados como Perdido desde o primeiro dia do mês atual."
        />
      </section>
    </TooltipProvider>
  );
}

function Metric({
  label,
  value,
  format,
  tooltip,
  valueClassName,
}: {
  label: string;
  value: number;
  format: (n: number) => string;
  tooltip: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Como ${label} é calculado`}
                className="ml-auto flex cursor-help text-muted-foreground hover:text-foreground"
              />
            }
          >
            <Info className="size-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <CountUp
        value={value}
        format={format}
        className={cn("truncate text-[17px] font-semibold text-foreground", valueClassName)}
      />
    </div>
  );
}
