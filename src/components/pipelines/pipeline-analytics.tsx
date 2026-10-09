"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { KpiStrip } from "@/components/ddm/kpi-strip";
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

  const money = (n: number) => formatCurrency(n, defaultCurrency);
  const count = (n: number) => Math.round(n).toLocaleString("pt-BR");

  // Faixa de indicadores (primitivo KpiStrip do redesenho); a explicação de
  // cada número abre no "i" (InfoHint: clique, teclado ou toque).
  return (
    <KpiStrip
      ariaLabel="Indicadores do pipeline"
      minWidth={150}
      items={[
        {
          label: "Total de negócios",
          value: <CountUp value={stats.totalCount} format={count} />,
          info: "Contagem de todos os negócios neste pipeline que não estão marcados como Perdido. Negócios Ganhos ainda são incluídos.",
        },
        {
          label: "Valor do pipeline",
          value: <CountUp value={stats.totalValue} format={money} />,
          info: "Soma dos valores de todos os negócios neste pipeline, excluindo os marcados como Perdido.",
        },
        {
          label: "Ticket médio",
          value: <CountUp value={stats.avgValue} format={money} />,
          info: "Valor do Pipeline dividido pelo Total de Negócios — o valor médio de um único negócio não perdido.",
        },
        {
          label: "Valor ponderado",
          value: <CountUp value={stats.weightedValue} format={money} />,
          info: "Receita esperada: valor de cada negócio aberto × probabilidade da etapa. Primeira etapa ≈ 10%, etapas progridem até 90%, Ganho = 100%. Negócios Perdidos são excluídos.",
        },
        {
          label: "Ganhos no mês",
          value: <CountUp value={stats.wonThisMonth} format={count} className="text-success" />,
          info: "Negócios marcados como Ganho desde o primeiro dia do mês atual.",
        },
        {
          label: "Perdidos no mês",
          value: <CountUp value={stats.lostThisMonth} format={count} className="text-danger" />,
          info: "Negócios marcados como Perdido desde o primeiro dia do mês atual.",
        },
      ]}
    />
  );
}
