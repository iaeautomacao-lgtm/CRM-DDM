"use client";

import type { AiAnalyticsData } from "@/lib/dashboard/types";

interface FinancialPerformanceProps {
  data: AiAnalyticsData | null;
  loading: boolean;
}

export function FinancialPerformance({ data, loading }: FinancialPerformanceProps) {
  if (loading || !data || !data.financials) {
    return (
      <div className="animate-pulse border-y border-border">
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="px-5 py-5">
              <div className="h-3 w-24 rounded bg-muted" />
              <div className="mt-3 h-7 w-32 rounded bg-muted" />
            </div>
          ))}
        </div>
        <div className="border-t border-border p-5">
          <div className="h-36 rounded bg-muted" />
        </div>
      </div>
    );
  }

  const { totalWonValue, totalOpenValue, ticketMedio, operators } = data.financials;

  return (
    <div className="border-y border-border">
      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <FinancialMetric label="Acordos ganhos" value={formatBRL(totalWonValue)} />
        <FinancialMetric label="Em negociação" value={formatBRL(totalOpenValue)} />
        <FinancialMetric label="Ticket médio" value={formatBRL(ticketMedio)} />
      </div>

      <div className="border-t border-border">
        <div className="flex items-center justify-between px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">Ranking de cobradores</h3>
          <span className="text-xs text-muted-foreground">{operators.length} atendentes</span>
        </div>

        {operators.length === 0 ? (
          <p className="border-t border-border px-5 py-8 text-center text-sm text-muted-foreground">
            Nenhum acordo ganho registrado.
          </p>
        ) : (
          <ol className="divide-y divide-border border-t border-border">
            {operators.map((op, idx) => (
              <li key={op.userId} className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-2.5 text-sm">
                <span className="text-xs font-medium tabular-nums text-muted-foreground">{idx + 1}º</span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{op.userName}</p>
                  <p className="text-xs text-muted-foreground">{op.dealCount} acordo{op.dealCount === 1 ? '' : 's'}</p>
                </div>
                <span className="font-medium tabular-nums text-foreground">{formatBRL(op.totalWon)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function FinancialMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function formatBRL(value: number) {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}
