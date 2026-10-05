"use client";

import { DollarSign, Award } from "lucide-react";
import type { AiAnalyticsData } from "@/lib/dashboard/types";

interface FinancialPerformanceProps {
  data: AiAnalyticsData | null;
  loading: boolean;
}

export function FinancialPerformance({ data, loading }: FinancialPerformanceProps) {
  if (loading || !data || !data.financials) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-pulse">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-5 h-48 space-y-4">
            <div className="h-4 bg-muted rounded w-1/3" />
            <div className="h-8 bg-muted rounded w-1/2" />
            <div className="h-3 bg-muted rounded w-full" />
          </div>
        ))}
      </div>
    );
  }

  const { totalWonValue, totalOpenValue, ticketMedio, operators } = data.financials;

  // O card "Meta de Recuperação" foi removido: comparava o total histórico
  // de acordos ganhos com uma meta fixa de exemplo (R$ 50.000), o que dava
  // um percentual sem significado. Volta quando houver meta configurável
  // e um total filtrado pelo mesmo período da meta.

  const formatBRL = (val: number) => {
    return val.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 0,
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* 1. Indicadores Financeiros Rápidos */}
      <div className="bg-card/50 backdrop-blur border border-border rounded-xl p-5 shadow-sm flex flex-col justify-between h-52">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <DollarSign className="h-4 w-4 text-emerald-500" />
            Acordos ganhos (total)
          </div>
          <div className="text-2xl font-extrabold text-foreground mt-1">
            {formatBRL(totalWonValue)}
          </div>
          <p className="text-xs text-muted-foreground">
            Soma de todos os acordos marcados como ganhos, desde o início
          </p>
        </div>

        <div className="border-t border-border/60 pt-3 grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <span className="text-muted-foreground block">Em Negociação</span>
            <span className="font-bold text-foreground">{formatBRL(totalOpenValue)}</span>
          </div>
          <div>
            <span className="text-muted-foreground block">Ticket Médio</span>
            <span className="font-bold text-foreground">{formatBRL(ticketMedio)}</span>
          </div>
        </div>
      </div>

      {/* 2. Ranking de Atendentes (Cobradores) */}
      <div className="bg-card/50 backdrop-blur border border-border rounded-xl p-5 shadow-sm flex flex-col justify-between h-52 overflow-hidden">
        <div className="space-y-1.5 mb-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Award className="h-4 w-4 text-primary" />
            Ranking de Cobradores
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1.5 scrollbar-thin">
          {operators.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">Nenhum acordo ganho registrado.</p>
          ) : (
            operators.map((op, idx) => (
              <div key={op.userId} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-bold text-muted-foreground w-4">{idx + 1}º</span>
                  <span className="font-medium text-foreground truncate">{op.userName}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-muted-foreground">({op.dealCount} acordos)</span>
                  <span className="font-bold text-emerald-500">{formatBRL(op.totalWon)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

