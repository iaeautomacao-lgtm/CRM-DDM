"use client";

import { Brain, Bot, Users, Percent, Award, TrendingUp } from "lucide-react";
import type { AiAnalyticsData } from "@/lib/dashboard/types";

interface AiPerformanceProps {
  data: AiAnalyticsData | null;
  loading: boolean;
}

export function AiPerformance({ data, loading }: AiPerformanceProps) {
  if (loading || !data) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-pulse">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-5 h-56 space-y-4">
            <div className="h-4 bg-muted rounded w-1/3" />
            <div className="h-8 bg-muted rounded w-1/2" />
            <div className="space-y-2">
              <div className="h-3 bg-muted rounded w-full" />
              <div className="h-3 bg-muted rounded w-5/6" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const { sentiment, messagesRatio, conversion } = data;

  // Percentage calculations
  const totalSentiment = sentiment.total || 1;
  const pctPositive = Math.round((sentiment.positive / totalSentiment) * 100);
  const pctNeutral = Math.round((sentiment.neutral / totalSentiment) * 100);
  const pctNegative = Math.round((sentiment.negative / totalSentiment) * 100);
  const pctMixed = Math.round((sentiment.mixed / totalSentiment) * 100);

  const totalOutbound = messagesRatio.total || 1;
  const pctBot = Math.round((messagesRatio.bot / totalOutbound) * 100);
  const pctHuman = Math.round((messagesRatio.human / totalOutbound) * 100);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* 1. Sentiment Card */}
      <div className="bg-card/50 backdrop-blur border border-border rounded-xl p-5 shadow-sm space-y-4 flex flex-col justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Brain className="h-4 w-4 text-primary" />
            Sentimento Geral
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold text-foreground">
              {pctPositive}%
            </span>
            <span className="text-xs text-emerald-500 font-medium flex items-center">
              Receptividade Positiva
            </span>
          </div>
        </div>

        <div className="space-y-2">
          {/* Positive bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground flex items-center gap-1">😊 Positivo</span>
              <span className="font-semibold text-foreground tabular-nums">{sentiment.positive} ({pctPositive}%)</span>
            </div>
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full opacity-80 shadow-[0_0_6px_rgba(16,185,129,0.5)]"
                style={{ width: `${pctPositive}%` }}
              />
            </div>
          </div>

          {/* Neutral bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground flex items-center gap-1">😐 Neutro</span>
              <span className="font-semibold text-foreground tabular-nums">{sentiment.neutral} ({pctNeutral}%)</span>
            </div>
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-slate-400 rounded-full opacity-80" style={{ width: `${pctNeutral}%` }} />
            </div>
          </div>

          {/* Negative bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground flex items-center gap-1">😡 Negativo</span>
              <span className="font-semibold text-foreground tabular-nums">{sentiment.negative} ({pctNegative}%)</span>
            </div>
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-rose-500 rounded-full opacity-80 shadow-[0_0_6px_rgba(244,63,94,0.5)]"
                style={{ width: `${pctNegative}%` }}
              />
            </div>
          </div>

          {/* Mixed bar */}
          {sentiment.mixed > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground flex items-center gap-1">😕 Misto</span>
                <span className="font-semibold text-foreground tabular-nums">{sentiment.mixed} ({pctMixed}%)</span>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full opacity-80" style={{ width: `${pctMixed}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Messages Ratio Card */}
      <div className="bg-card/50 backdrop-blur border border-border rounded-xl p-5 shadow-sm space-y-4 flex flex-col justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Bot className="h-4 w-4 text-primary" />
            Automação vs Humano
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold text-foreground">
              {pctBot}%
            </span>
            <span className="text-xs text-primary font-medium">
              Atendimentos pela IA
            </span>
          </div>
        </div>

        <div className="space-y-3.5">
          <div className="flex items-center justify-between text-xs border-b border-border pb-2">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Bot className="h-3.5 w-3.5 text-primary" /> Robô de IA
            </span>
            <span className="font-bold text-foreground">{messagesRatio.bot} mensagens</span>
          </div>
          <div className="flex items-center justify-between text-xs border-b border-border pb-2">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-muted-foreground" /> Atendentes
            </span>
            <span className="font-bold text-foreground">{messagesRatio.human} mensagens</span>
          </div>

          {/* Double fill progress bar */}
          <div className="space-y-1">
            <div className="h-2.5 w-full bg-muted rounded-full overflow-hidden flex">
              <div className="h-full bg-primary" style={{ width: `${pctBot}%` }} title={`Robô: ${pctBot}%`} />
              <div className="h-full bg-slate-400" style={{ width: `${pctHuman}%` }} title={`Humano: ${pctHuman}%`} />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Robô ({pctBot}%)</span>
              <span>Humano ({pctHuman}%)</span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Conversion Card */}
      <div className="bg-card/50 backdrop-blur border border-border rounded-xl p-5 shadow-sm space-y-4 flex flex-col justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Percent className="h-4 w-4 text-primary" />
            Conversão do Funil
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold text-foreground">
              {conversion.rate}%
            </span>
            <span className="text-xs text-emerald-500 font-medium flex items-center gap-0.5">
              <TrendingUp className="h-3 w-3" /> Fechamento de Vendas
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-muted/40 rounded-lg p-2.5 space-y-0.5 border border-border/50">
            <span className="text-[10px] uppercase font-bold text-emerald-500">Ganhos</span>
            <div className="text-sm font-bold text-foreground">{conversion.won}</div>
          </div>
          <div className="bg-muted/40 rounded-lg p-2.5 space-y-0.5 border border-border/50">
            <span className="text-[10px] uppercase font-bold text-rose-500">Perdidos</span>
            <div className="text-sm font-bold text-foreground">{conversion.lost}</div>
          </div>
          <div className="bg-muted/40 rounded-lg p-2.5 space-y-0.5 border border-border/50">
            <span className="text-[10px] uppercase font-bold text-muted-foreground">Abertos</span>
            <div className="text-sm font-bold text-foreground">{conversion.open}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
