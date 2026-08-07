"use client";

import { Activity, Bot, Clock, UserCheck } from "lucide-react";
import type { ComponentType } from "react";

interface KpiRowProps {
  total: number;
  navegando: number;
  espera: number;
  atendimento: number;
  loading: boolean;
}

const ITEMS: {
  key: keyof Omit<KpiRowProps, "loading">;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { key: "total", label: "Geral", icon: Activity },
  { key: "navegando", label: "Auto", icon: Bot },
  { key: "espera", label: "Espera", icon: Clock },
  { key: "atendimento", label: "Humano", icon: UserCheck },
];

/**
 * Live KPI strip for the Monitoramento board. Unlike the Dashboard's
 * `MetricCard` (muted icon badge, delta-vs-yesterday), these are
 * always-orange to read as "live now" — no delta, since there's no
 * meaningful "vs yesterday" for an instantaneous phase count.
 */
export function MonitorKpiRow({ total, navegando, espera, atendimento, loading }: KpiRowProps) {
  const values = { total, navegando, espera, atendimento };
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {ITEMS.map(({ key, label, icon: Icon }) => (
        <div key={key} className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between">
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-4 w-4" />
            </div>
          </div>
          {loading ? (
            <div className="mt-3 h-8 w-16 animate-pulse rounded-md bg-muted" />
          ) : (
            <p className="mt-3 text-[28px] leading-none font-bold tabular-nums text-foreground">
              {values[key].toLocaleString()}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
