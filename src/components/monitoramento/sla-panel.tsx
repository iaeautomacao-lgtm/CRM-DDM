"use client";

// Aba "SLA" do Monitoramento: primeira resposta e fila atual por canal e
// por equipe. Dados de /api/monitoramento/sla (agregação em
// src/lib/monitoramento/sla.ts). Atualiza a cada minuto enquanto aberta.

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { SlaStats } from "@/lib/monitoramento/sla";

interface SlaResponse {
  days: number;
  target_minutes: number;
  truncated: boolean;
  total: SlaStats;
  byChannel: SlaStats[];
  byTeam: SlaStats[];
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  webchat: "Webchat",
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "SMS",
};

const PERIODS = [1, 7, 30] as const;
const REFRESH_MS = 60_000;

function fmtMinutes(min: number | null): string {
  if (min === null) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  return h < 24 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
}

export function SlaPanel({ teamNames }: { teamNames: Record<string, string> }) {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const [data, setData] = useState<SlaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/monitoramento/sla?days=${days}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as SlaResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar SLA");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const target = data?.target_minutes ?? 15;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setDays(p)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium",
              days === p ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            )}
          >
            {p === 1 ? "Hoje (24h)" : `${p} dias`}
          </button>
        ))}
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} className="ml-auto">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Na fila agora" value={String(data.total.queued)} hint={`maior espera ${fmtMinutes(data.total.longestWaitMin)}`} />
            <Kpi label="1ª resposta (média)" value={fmtMinutes(data.total.firstResponseAvgMin)} hint={`p90 ${fmtMinutes(data.total.firstResponseP90Min)}`} />
            <Kpi
              label={`Dentro de ${target} min`}
              value={data.total.withinTargetPct === null ? "—" : `${data.total.withinTargetPct}%`}
              hint={`${data.total.responded} respondidas`}
            />
            <Kpi label="Conversas no período" value={String(data.total.created)} hint={`${data.days} dia(s)`} />
          </div>

          <SlaTable title="Por canal" rows={data.byChannel} labelFor={(k) => CHANNEL_LABEL[k] ?? k} target={target} />
          <SlaTable
            title="Por equipe"
            rows={data.byTeam}
            labelFor={(k) => (k === "none" ? "Sem equipe" : teamNames[k] ?? "Equipe removida")}
            target={target}
          />
          {data.truncated && (
            <p className="text-xs text-muted-foreground">Período muito grande: parte das conversas ficou de fora.</p>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function SlaTable({
  title,
  rows,
  labelFor,
  target,
}: {
  title: string;
  rows: SlaStats[];
  labelFor: (key: string) => string;
  target: number;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <p className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">{title}</p>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium" />
            <th className="px-3 py-2 font-medium">Conversas</th>
            <th className="px-3 py-2 font-medium">1ª resposta</th>
            <th className="px-3 py-2 font-medium">p90</th>
            <th className="px-3 py-2 font-medium">≤ {target} min</th>
            <th className="px-3 py-2 font-medium">Na fila</th>
            <th className="px-3 py-2 font-medium">Maior espera</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">
                Sem dados no período
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="px-3 py-2 font-medium text-foreground">{labelFor(r.key)}</td>
                <td className="px-3 py-2">{r.created}</td>
                <td className="px-3 py-2">{fmtMinutes(r.firstResponseAvgMin)}</td>
                <td className="px-3 py-2">{fmtMinutes(r.firstResponseP90Min)}</td>
                <td
                  className={cn(
                    "px-3 py-2",
                    r.withinTargetPct !== null && r.withinTargetPct < 80 ? "text-amber-600" : undefined
                  )}
                >
                  {r.withinTargetPct === null ? "—" : `${r.withinTargetPct}%`}
                </td>
                <td className={cn("px-3 py-2", r.queued > 0 ? "font-semibold text-foreground" : undefined)}>{r.queued}</td>
                <td className="px-3 py-2">{fmtMinutes(r.longestWaitMin)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
