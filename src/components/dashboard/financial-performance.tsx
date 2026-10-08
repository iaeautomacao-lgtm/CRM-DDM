"use client";

import type { AiAnalyticsData } from "@/lib/dashboard/types";

interface FinancialPerformanceProps {
  data: AiAnalyticsData | null;
  loading: boolean;
}

export function FinancialPerformance({ data, loading }: FinancialPerformanceProps) {
  if (loading || !data || !data.financials) {
    return (
      <div className="animate-pulse">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr_1fr]">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="py-2">
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
    <div className="">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr_1fr]">
        <FinancialMetric label="Acordos ganhos" value={formatBRL(totalWonValue)} primary />
        <FinancialMetric label="Em negociação" value={formatBRL(totalOpenValue)} />
        <FinancialMetric label="Ticket médio" value={formatBRL(ticketMedio)} />
      </div>

      <div className="mt-6 border-t border-border">
        <div className="flex items-center justify-between py-3">
          <h3 className="text-sm font-semibold text-foreground">Ranking de cobradores</h3>
          <span className="text-xs text-muted-foreground">{operators.length} atendentes</span>
        </div>

        {operators.length === 0 ? (
          <p className="border-t border-border py-8 text-center text-sm text-muted-foreground">
            Nenhum acordo ganho registrado.
          </p>
        ) : (
          <ol className="divide-y divide-border border-t border-border">
            {operators.map((op, idx) => (
              <li key={op.userId} className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-sm">
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

function FinancialMetric({ label, value, primary = false }: { label: string; value: string; primary?: boolean }) {
  return (
    <div className="px-5 py-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={primary ? "mt-2 text-[30px] font-semibold tracking-[-0.03em] tabular-nums text-foreground" : "mt-2 text-[22px] font-semibold tracking-tight tabular-nums text-foreground"}>{value}</p>
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
