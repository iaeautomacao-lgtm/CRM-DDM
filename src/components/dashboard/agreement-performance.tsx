"use client";

import {
  Bot,
  CalendarDays,
  CircleHelp,
  Handshake,
  UserRound,
} from "lucide-react";

import { SkeletonCard } from "./skeleton";
import type { AgreementDashboardMetrics } from "@/lib/dashboard/agreement-metrics";

interface AgreementPerformanceProps {
  data: AgreementDashboardMetrics | null;
  loading: boolean;
}

export function AgreementPerformance({ data, loading }: AgreementPerformanceProps) {
  if (loading || !data) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <SkeletonCard key={index} className="min-h-[156px]" />
        ))}
      </div>
    );
  }

  const nf = new Intl.NumberFormat("pt-BR");
  const entries = [
    {
      label: "Acordos registrados",
      value: data.total,
      description: "Total atual com tabulação Acordo Realizado",
      icon: Handshake,
      color: "text-emerald-500",
    },
    {
      label: "Registrados pela IA",
      value: data.ai,
      description: "Registro feito pela automação de IA",
      icon: Bot,
      color: "text-primary",
    },
    {
      label: "Registrados por humanos",
      value: data.human,
      description: "Tabulação registrada por usuário",
      icon: UserRound,
      color: "text-foreground",
    },
    {
      label: "Origem não identificada",
      value: data.unknown,
      description: "Sem evidência suficiente na auditoria",
      icon: CircleHelp,
      color: "text-amber-500",
    },
  ] as const;

  const barSections = [
    { key: "ai", value: data.ai, color: "bg-primary" },
    { key: "human", value: data.human, color: "bg-slate-400" },
    { key: "unknown", value: data.unknown, color: "bg-amber-500" },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {entries.map(({ label, value, description, icon: Icon, color }) => (
          <div key={label} className="rounded-xl border border-border bg-card/50 p-5 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-muted-foreground">{label}</h4>
              <Icon className={"h-4 w-4 shrink-0 " + color} aria-hidden="true" />
            </div>
            <p className={"mt-3 text-3xl font-bold tabular-nums " + color}>
              {nf.format(value)}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-border bg-card/50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-foreground">Origem dos registros</h4>
            <span className="text-xs text-muted-foreground">
              {nf.format(data.attributed)} de {nf.format(data.total)} atribuídos ({data.attributionCoverage}%)
            </span>
          </div>
          <div
            className="mt-4 flex h-3 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={"Registros por origem: " + data.ai + " IA, " + data.human + " humanos, " + data.unknown + " não identificados"}
          >
            {barSections.map((item) =>
              item.value > 0 ? (
                <div
                  key={item.key}
                  className={item.color}
                  style={{ width: (100 * item.value / Math.max(data.total, 1)) + "%" }}
                />
              ) : null,
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Participação da IA entre registros atribuídos</span>
            <span className="font-semibold tabular-nums text-foreground">
              {data.attributed ? data.aiShareOfAttributed + "%" : "Não disponível"}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
            A origem identifica quem gravou a tabulação, não necessariamente quem conduziu a negociação.
            Acordo registrado não é confirmação de pagamento recebido.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card/50 p-5">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
            <h4 className="text-sm font-semibold text-foreground">Atendimentos encerrados com acordo</h4>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Hoje", value: data.closedToday },
              { label: "7 dias", value: data.closedLast7Days },
              { label: "30 dias", value: data.closedLast30Days },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-lg border border-border/60 bg-muted/40 px-2 py-3">
                <p className="text-xl font-bold tabular-nums text-foreground">{nf.format(value)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Data de encerramento da conversa, em Brasília. Períodos de 7 e 30 dias são móveis.
          </p>
        </div>
      </div>
    </div>
  );
}
