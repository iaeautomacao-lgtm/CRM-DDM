"use client";

// Aba "Hoje" do Monitoramento: o dia (calendário de Brasília) em números —
// recebidas, atendidas, finalizadas, em aberto, 1ª resposta, hora a hora e
// por atendente/equipe/canal. Dados de /api/monitoramento/dia (agregação em
// src/lib/monitoramento/day-view.ts). Hoje atualiza a cada minuto.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { ErrorState } from "@/components/ddm/states";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dayBounds, todayInBrazil, type DayStats, type DayView } from "@/lib/monitoramento/day-view";
import {
  ConversationDrilldown,
  type DrilldownMetric,
  type DrilldownQuery,
} from "@/components/monitoramento/conversation-drilldown";

interface DayResponse extends DayView {
  is_today: boolean;
  transfers: number;
  truncated: boolean;
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  webchat: "Webchat",
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "SMS",
};
const REFRESH_MS = 60_000;

function fmtMinutes(min: number | null): string {
  if (min === null) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  return `${(min / 60).toFixed(1)} h`;
}

export function DayPanel({
  agentNames,
  teamNames,
}: {
  agentNames: Record<string, string>;
  teamNames: Record<string, string>;
}) {
  const [date, setDate] = useState(() => todayInBrazil());
  const [data, setData] = useState<DayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Só a resposta da data mais recente vale (troca rápida de dia).
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/monitoramento/dia?date=${date}`);
      const json = await res.json();
      if (seq !== requestSeq.current) return;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as DayResponse);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : "Falha ao carregar o dia");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [date]);

  const isToday = date === todayInBrazil();
  useEffect(() => {
    void load();
    if (!isToday) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, isToday]);

  const maxHour = data ? Math.max(1, ...data.hourly) : 1;
  // Clique num número → lista das conversas daquele número (com link).
  const [drill, setDrill] = useState<DrilldownQuery | null>(null);
  const bounds = dayBounds(date);
  const METRIC_LABEL: Record<DrilldownMetric, string> = {
    received: "Recebidas",
    attended: "Atendidas",
    closed: "Finalizadas",
    open: "Em aberto agora",
    queued: "Na fila",
  };
  const open = (metric: DrilldownMetric, dim?: "agent" | "team" | "channel", key?: string, keyLabel?: string) =>
    setDrill({
      title: `${METRIC_LABEL[metric]}${keyLabel ? ` · ${keyLabel}` : ""}${metric === "open" ? "" : ` · ${date.split("-").reverse().join("/")}`}`,
      metric,
      from: new Date(bounds.startMs).toISOString(),
      to: new Date(bounds.endMs).toISOString(),
      dim,
      key,
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={date}
          max={todayInBrazil()}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="h-8 w-40 text-xs"
          aria-label="Dia"
        />
        {!isToday && (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setDate(todayInBrazil())}>
            Hoje
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} className="ml-auto">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {error && (
        <ErrorState
          className="min-h-0"
          title="Não foi possível carregar o dia"
          hint={data ? "Os números abaixo podem estar desatualizados. Tente de novo." : error}
          onRetry={() => void load()}
        />
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Recebidas" value={data.total.received} onClick={() => open("received")} />
            <Kpi label="Atendidas" value={data.total.attended} onClick={() => open("attended")} />
            <Kpi label="Finalizadas" value={data.total.closed} onClick={() => open("closed")} />
            <Kpi
              label="Em aberto agora"
              value={data.is_today ? data.total.open : "—"}
              onClick={data.is_today ? () => open("open") : undefined}
            />
            <Kpi label="1ª resposta (média)" value={fmtMinutes(data.total.firstResponseAvgMin)} />
            <Kpi label="Transferências" value={data.transfers} />
          </div>

          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-2 text-xs font-semibold text-foreground">Recebidas por hora</p>
            <div className="flex h-28 items-end gap-1">
              {data.hourly.map((n, h) => (
                <div key={h} className="flex flex-1 flex-col items-center gap-1" title={`${h}h: ${n}`}>
                  <div
                    className={cn("w-full rounded-t", n > 0 ? "bg-primary/70" : "bg-muted")}
                    style={{ height: `${Math.max(4, (n / maxHour) * 96)}px` }}
                  />
                  <span className="text-[9px] text-muted-foreground">{h % 3 === 0 ? h : ""}</span>
                </div>
              ))}
            </div>
          </div>

          <DayTable
            title="Por atendente"
            rows={data.byAgent}
            labelFor={(k) => (k === "none" ? "Sem atendente" : agentNames[k] ?? "Atendente")}
            showOpen={data.is_today}
            onOpen={(metric, key, label) => open(metric, "agent", key, label)}
          />
          <DayTable
            title="Por equipe"
            rows={data.byTeam}
            labelFor={(k) => (k === "none" ? "Sem equipe" : teamNames[k] ?? "Equipe removida")}
            showOpen={data.is_today}
            onOpen={(metric, key, label) => open(metric, "team", key, label)}
          />
          <DayTable
            title="Por canal"
            rows={data.byChannel}
            labelFor={(k) => CHANNEL_LABEL[k] ?? k}
            showOpen={data.is_today}
            onOpen={(metric, key, label) => open(metric, "channel", key, label)}
          />
          {data.truncated && (
            <p className="text-xs text-muted-foreground">Dia com muitas conversas: parte ficou de fora.</p>
          )}
        </>
      )}
      <ConversationDrilldown query={drill} onClose={() => setDrill(null)} />
    </div>
  );
}

/** Número clicável de uma célula (abre a lista de conversas). */
function CellButton({ value, onClick }: { value: number; onClick: () => void }) {
  if (value === 0) return <span className="text-muted-foreground">0</span>;
  return (
    <button type="button" onClick={onClick} className="font-medium text-primary underline-offset-2 hover:underline">
      {value.toLocaleString("pt-BR")}
    </button>
  );
}

function Kpi({ label, value, onClick }: { label: string; value: number | string; onClick?: () => void }) {
  const body = (
    <>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
      title="Ver as conversas"
    >
      {body}
    </button>
  ) : (
    <div className="rounded-xl border border-border bg-card p-3">{body}</div>
  );
}

function DayTable({
  title,
  rows,
  labelFor,
  showOpen,
  onOpen,
}: {
  title: string;
  rows: DayStats[];
  labelFor: (key: string) => string;
  showOpen: boolean;
  onOpen: (metric: DrilldownMetric, key: string, label: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <p className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">{title}</p>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium" />
            <th className="px-3 py-2 font-medium">Recebidas</th>
            <th className="px-3 py-2 font-medium">Atendidas</th>
            <th className="px-3 py-2 font-medium">Finalizadas</th>
            {showOpen && <th className="px-3 py-2 font-medium">Em aberto</th>}
            <th className="px-3 py-2 font-medium">1ª resposta</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={showOpen ? 6 : 5} className="px-3 py-4 text-center text-muted-foreground">
                Sem movimento no dia
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="px-3 py-2 font-medium text-foreground">{labelFor(r.key)}</td>
                <td className="px-3 py-2 tabular-nums">
                  <CellButton value={r.received} onClick={() => onOpen("received", r.key, labelFor(r.key))} />
                </td>
                <td className="px-3 py-2 tabular-nums">
                  <CellButton value={r.attended} onClick={() => onOpen("attended", r.key, labelFor(r.key))} />
                </td>
                <td className="px-3 py-2 tabular-nums">
                  <CellButton value={r.closed} onClick={() => onOpen("closed", r.key, labelFor(r.key))} />
                </td>
                {showOpen && (
                  <td className="px-3 py-2 tabular-nums">
                    <CellButton value={r.open} onClick={() => onOpen("open", r.key, labelFor(r.key))} />
                  </td>
                )}
                <td className="px-3 py-2">{fmtMinutes(r.firstResponseAvgMin)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
