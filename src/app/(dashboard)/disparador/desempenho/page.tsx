"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Cpu,
  Gauge,
  HardDrive,
  Info,
  Loader2,
  Megaphone,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
} from "recharts";

import { apiFetch } from "@/lib/api-fetch";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Capacity, ChannelStats } from "@/lib/disparador/desempenho-extra";
import { formatInt } from "@/lib/disparador/monitor-format";
import type {
  ChannelInfo,
  DesempenhoWindow,
  FormattedTickRow,
  ThroughputDataPoint,
  WindowMetricsSummary,
} from "@/lib/disparador/desempenho";

const WINDOW_OPTIONS: Array<{ key: DesempenhoWindow; label: string }> = [
  { key: "15m", label: "Últimos 15 min" },
  { key: "1h", label: "Última 1 hora" },
  { key: "6h", label: "Últimas 6 horas" },
  { key: "24h", label: "Últimas 24 horas" },
];

const PALETTE = [
  "#f97316", // Laranja DDM
  "#3b82f6", // Azul
  "#10b981", // Esmeralda
  "#8b5cf6", // Violeta
  "#f59e0b", // Âmbar
  "#ec4899", // Rosa
  "#06b6d4", // Ciano
  "#64748b", // Ardósia
];

interface LivePerformanceSnapshot {
  sampledAt: string;
  activeCampaigns: number;
  queued: number;
  sending: number;
  errors: number;
  blocked: number;
  remaining: number;
  sentLast60s: number;
}

export default function DisparadorDesempenhoPage() {
  const [janela, setJanela] = useState<DesempenhoWindow>("1h");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<WindowMetricsSummary | null>(null);
  const [ticks, setTicks] = useState<FormattedTickRow[]>([]);
  const [throughputSeries, setThroughputSeries] = useState<ThroughputDataPoint[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [channelStats, setChannelStats] = useState<ChannelStats[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [truncated, setTruncated] = useState<{ ticks: boolean; throughput: boolean } | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [live, setLive] = useState<LivePerformanceSnapshot | null>(null);
  const [lastLiveAt, setLastLiveAt] = useState<Date | null>(null);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState(30);

  const isMountedRef = useRef(true);
  const liveRequestInFlightRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchData = useCallback(
    async (isBackground = false) => {
      if (!isBackground) {
        setLoading(true);
        setError(null);
      } else {
        setRefreshing(true);
      }

      try {
        const res = await apiFetch(`/api/disparador/desempenho?janela=${janela}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.error || `Erro HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!isMountedRef.current) return;

        if (data.ok) {
          setMetrics(data.metrics);
          setTicks(data.ticks ?? []);
          setThroughputSeries(data.throughputSeries ?? []);
          setChannels(data.channels ?? []);
          setChannelStats(data.channelStats ?? []);
          setCapacity(data.capacity ?? null);
          setTruncated(data.truncated ?? null);
          setLastRefreshedAt(new Date());
          setSecondsUntilRefresh(30);
        } else {
          throw new Error(data.error || "Resposta inválida do servidor");
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        const msg = err instanceof Error ? err.message : "Falha ao carregar dados";
        console.error("[Desempenho] Erro ao carregar:", err);
        setError(msg);
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [janela]
  );

  const fetchLiveData = useCallback(async () => {
    if (liveRequestInFlightRef.current) return;
    liveRequestInFlightRef.current = true;
    try {
      const res = await apiFetch("/api/disparador/desempenho/live");
      if (!res.ok) return;
      const data = await res.json();
      if (!isMountedRef.current || !data.ok || !data.live) return;
      setLive(data.live as LivePerformanceSnapshot);
      setLastLiveAt(new Date(data.live.sampledAt));
    } catch (err) {
      // O snapshot ao vivo é complementar. Se ele falhar, a telemetria
      // histórica de 30s continua funcional e a tela não entra em erro.
      console.warn("[Desempenho] Snapshot ao vivo indisponível:", err);
    } finally {
      liveRequestInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchData(false);
    void fetchLiveData();
  }, [fetchData, fetchLiveData]);

  // Snapshot operacional: curto e barato. Pausa quando a aba fica oculta
  // para não gerar carga sem benefício visual.
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void fetchLiveData();
    }, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLiveData]);

  // Telemetria histórica continua a cada 30 segundos
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      setSecondsUntilRefresh((prev) => {
        if (prev <= 1) {
          void fetchData(true);
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  // Lista de chaves de canal presentes nos dados do gráfico
  const channelDataKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const point of throughputSeries) {
      for (const k of Object.keys(point)) {
        if (k !== "minute" && k !== "displayTime" && k !== "total") {
          keys.add(k);
        }
      }
    }
    // Se não encontrou chaves de canal específicas, usa total
    if (keys.size === 0) {
      return ["total"];
    }
    return Array.from(keys);
  }, [throughputSeries]);

  return (
    <div className="flex flex-col space-y-6 p-4 lg:p-6 max-w-7xl mx-auto">
      {/* Header com navegação e controles */}
      <div className="flex flex-col justify-between gap-4 border-b border-border/60 pb-5 lg:flex-row lg:items-center">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/disparador/campanhas"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors mr-1"
              title="Voltar para Campanhas"
              aria-label="Voltar para Campanhas"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Link>
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <Gauge className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Desempenho do Disparador
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Estado operacional atualizado a cada ~3s; saúde do processo e histórico consolidados por tick.
          </p>
        </div>

        {/* Ações do topo: janelas, auto-refresh e atualização manual */}
        <div className="flex flex-wrap items-center gap-2 self-start lg:self-center">
          {/* Seletor de janela de tempo */}
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1 text-xs">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setJanela(opt.key)}
                className={cn(
                  "rounded-md px-2.5 py-1.5 font-medium transition-colors",
                  janela === opt.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={janela === opt.key}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Toggle Auto-refresh */}
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            <Switch
              id="switch-auto-refresh"
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
              className="scale-90"
              aria-label="Estado operacional a cada 3 segundos e histórico a cada 30 segundos"
            />
            <Label
              htmlFor="switch-auto-refresh"
              className="cursor-pointer text-xs flex items-center gap-1.5 font-normal"
            >
              <Radio className={cn("size-3.5", autoRefresh ? "text-emerald-500 animate-pulse" : "text-muted-foreground")} />
              <span>Live 3s · histórico {autoRefresh ? `(${secondsUntilRefresh}s)` : "(pausado)"}</span>
            </Label>
          </div>

          {/* Botão Atualizar Agora */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void fetchData(true);
              void fetchLiveData();
            }}
            disabled={refreshing || loading}
            className="gap-1.5 text-xs h-9"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", (refreshing || loading) && "animate-spin")} />
            <span>Atualizar</span>
          </Button>

          {/* Link para Monitor em tempo real */}
          <Link
            href="/disparador/monitor"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5 text-xs h-9 text-muted-foreground")}
          >
            <Activity className="h-3.5 w-3.5" />
            <span>Monitor</span>
          </Link>
        </div>
      </div>

      {/* Atualização: snapshot operacional curto + histórico pesado separado */}
      {(lastRefreshedAt || lastLiveAt) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground -mt-3">
          <span>
            Ao vivo: {lastLiveAt ? lastLiveAt.toLocaleTimeString("pt-BR") : "—"}
            {" · "}
            Histórico: {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString("pt-BR") : "—"}
          </span>
          {metrics && (
            <span>
              {metrics.totalTicks} {metrics.totalTicks === 1 ? "minuto registrado" : "minutos registrados"} na janela de {janela}
            </span>
          )}
        </div>
      )}

      {live && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 -mt-2" aria-label="Estado operacional ao vivo">
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Campanhas ativas</p>
            <p className="mt-0.5 text-lg font-bold text-foreground">{live.activeCampaigns.toLocaleString("pt-BR")}</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">A enviar</p>
            <p className="mt-0.5 text-lg font-bold text-foreground">{live.remaining.toLocaleString("pt-BR")}</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Processando agora</p>
            <p className="mt-0.5 text-lg font-bold text-primary">{live.sending.toLocaleString("pt-BR")}</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Falhas na campanha ativa</p>
            <p className="mt-0.5 text-lg font-bold text-foreground">{(live.errors + live.blocked).toLocaleString("pt-BR")}</p>
          </div>
        </div>
      )}

      {/* Estados de Carregamento e Erro */}
      {loading ? (
        <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card p-12 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-medium text-foreground">Carregando métricas de desempenho…</p>
          <p className="text-xs text-muted-foreground">Consultando telemetria do motor de disparo e vazão por minuto.</p>
        </div>
      ) : error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <AlertTriangle className="h-8 w-8 text-destructive" />
            <h3 className="font-semibold text-foreground">Não foi possível carregar a telemetria</h3>
            <p className="max-w-md text-xs text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void fetchData(false)} className="mt-2">
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : ticks.length === 0 && !(live && (live.activeCampaigns > 0 || live.sentLast60s > 0)) ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Megaphone className="h-10 w-10 text-muted-foreground/40" />
            <h3 className="font-semibold text-foreground">Nenhum tick registrado na janela selecionada</h3>
            <p className="max-w-md text-xs text-muted-foreground">
              O motor de disparo grava uma linha de telemetria por minuto em <code>wacrm.system_logs</code> durante a execução do cron.
              Tente selecionar uma janela maior (ex.: 6h ou 24h) ou inicie um disparo para observar os dados.
            </p>
            <div className="flex gap-2 mt-2">
              <Button size="sm" variant="outline" onClick={() => setJanela("6h")}>
                Ver últimas 6 horas
              </Button>
              <Button size="sm" variant="outline" onClick={() => setJanela("24h")}>
                Ver últimas 24 horas
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 1. CARDS DE MÉTRICAS */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {/* Card: Envios por minuto */}
            <Card className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-xs font-semibold text-muted-foreground">
                  Envios / Min
                </CardTitle>
                <TrendingUp className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {(live?.sentLast60s ?? metrics?.nowSent ?? 0).toLocaleString("pt-BR")}
                  <span className="text-xs font-normal text-muted-foreground ml-1">últimos 60s</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Média: <strong className="text-foreground">{metrics?.avgSentPerMinute ?? 0}</strong>/min · Total: {metrics?.totalSent.toLocaleString("pt-BR")}
                </p>
              </CardContent>
            </Card>

            {/* Card: Latência Meta p95 */}
            <Card
              className={cn(
                "shadow-sm transition-colors",
                metrics?.latestMetaP95 && metrics.latestMetaP95 > 2000
                  ? "border-destructive bg-destructive/5"
                  : metrics?.latestMetaP95 && metrics.latestMetaP95 > 1500
                  ? "border-amber-500/50 bg-amber-500/5"
                  : ""
              )}
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-xs font-semibold text-muted-foreground">
                  Latência Meta (p95)
                </CardTitle>
                <Clock
                  className={cn(
                    "h-4 w-4",
                    metrics?.latestMetaP95 && metrics.latestMetaP95 > 2000
                      ? "text-destructive"
                      : metrics?.latestMetaP95 && metrics.latestMetaP95 > 1500
                      ? "text-amber-500"
                      : "text-muted-foreground"
                  )}
                />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {metrics?.latestMetaP95 ? `${metrics.latestMetaP95.toLocaleString("pt-BR")} ms` : "—"}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Média: <strong className="text-foreground">{metrics?.avgMetaP95 ?? 0} ms</strong> na janela
                </p>
              </CardContent>
            </Card>

            {/* Card: Lentidão do Servidor (Event Loop p99) */}
            <Card
              className={cn(
                "shadow-sm transition-colors",
                metrics?.latestLagP99 && metrics.latestLagP99 > 100
                  ? "border-destructive bg-destructive/5"
                  : metrics?.latestLagP99 && metrics.latestLagP99 > 50
                  ? "border-amber-500/50 bg-amber-500/5"
                  : ""
              )}
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-xs font-semibold text-muted-foreground">
                  Lentidão Servidor (p99)
                </CardTitle>
                <Cpu
                  className={cn(
                    "h-4 w-4",
                    metrics?.latestLagP99 && metrics.latestLagP99 > 100
                      ? "text-destructive"
                      : metrics?.latestLagP99 && metrics.latestLagP99 > 50
                      ? "text-amber-500"
                      : "text-muted-foreground"
                  )}
                />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {metrics?.latestLagP99 ?? 0}
                  <span className="text-xs font-normal text-muted-foreground ml-1">ms</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Pico: <strong className="text-foreground">{metrics?.peakLagP99 ?? 0} ms</strong> (corte: 200 ms)
                </p>
              </CardContent>
            </Card>

            {/* Card: Memória do Processo (RSS) */}
            <Card
              className={cn(
                "shadow-sm transition-colors",
                metrics?.peakRssMb && metrics.peakRssMb > 600
                  ? "border-destructive bg-destructive/5"
                  : metrics?.peakRssMb && metrics.peakRssMb > 500
                  ? "border-amber-500/50 bg-amber-500/5"
                  : ""
              )}
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-xs font-semibold text-muted-foreground">
                  Memória Pico (RSS)
                </CardTitle>
                <HardDrive
                  className={cn(
                    "h-4 w-4",
                    metrics?.peakRssMb && metrics.peakRssMb > 600
                      ? "text-destructive"
                      : metrics?.peakRssMb && metrics.peakRssMb > 500
                      ? "text-amber-500"
                      : "text-muted-foreground"
                  )}
                />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {metrics?.peakRssMb ?? 0}
                  <span className="text-xs font-normal text-muted-foreground ml-1">MB</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Atual: <strong className="text-foreground">{metrics?.latestRssMb ?? 0} MB</strong> (corte: 1.024 MB)
                </p>
              </CardContent>
            </Card>

            {/* Card: Freio Acionado (Backoff) */}
            <Card
              className={cn(
                "shadow-sm transition-colors",
                metrics?.hasBrakeTriggered
                  ? "border-destructive/60 bg-destructive/5"
                  : "border-emerald-500/30 bg-emerald-500/5"
              )}
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-xs font-semibold text-muted-foreground">
                  Freio Acionado?
                </CardTitle>
                {metrics?.hasBrakeTriggered ? (
                  <ShieldAlert className="h-4 w-4 text-destructive" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                )}
              </CardHeader>
              <CardContent>
                <div
                  className={cn(
                    "text-2xl font-bold tracking-tight",
                    metrics?.hasBrakeTriggered
                      ? "text-destructive"
                      : "text-emerald-700 dark:text-emerald-400"
                  )}
                >
                  {metrics?.hasBrakeTriggered ? "Sim" : "Não"}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {metrics?.hasBrakeTriggered
                    ? `${metrics.totalBackoffEvents} evento(s) de redução`
                    : "Fluxo desimpedido (sem recuo)"}
                </p>
              </CardContent>
            </Card>

            {/* Card: Configuração Ativa (Knobs) */}
            <Card className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-xs font-semibold text-muted-foreground">
                  Configuração Ativa
                </CardTitle>
                <Sliders className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {metrics?.activeKnobs?.global_concurrency ?? 12}
                  <span className="text-xs font-normal text-muted-foreground ml-1">vagas globais</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground truncate">
                  Meta: <strong className="text-foreground">{metrics?.activeKnobs?.per_number?.meta ?? 12}</strong> · WAHA: {metrics?.activeKnobs?.per_number?.waha ?? 2} · Orç: {Math.round((metrics?.budgetMs ?? 35000) / 1000)}s
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Alerta consolidado se houver erros 429 ou backoff ativo */}
          {(metrics?.hasBrakeTriggered || (metrics?.rateLimitErrorsTotal ?? 0) > 0) && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2.5">
              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
              <div className="space-y-0.5">
                <strong className="font-semibold">Atenção operacional durante a janela:</strong>
                <div>
                  {metrics?.hasBrakeTriggered && (
                    <span className="mr-3">
                      • O motor acionou o freio adaptativo em {metrics.totalBackoffEvents} ocasião(ões).
                    </span>
                  )}
                  {(metrics?.rateLimitErrorsTotal ?? 0) > 0 && (
                    <span>
                      • Ocorreram {metrics?.rateLimitErrorsTotal} erro(s) de taxa da Meta (
                      {Object.entries(metrics?.rateErrorsBreakdown ?? {})
                        .map(([code, count]) => `${code}: ${count}`)
                        .join(", ")}
                      ).
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 2. GRÁFICO DE ENVIOS POR MINUTO POR NÚMERO */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                    <TrendingUp className="size-4 text-primary" />
                    Envios por Minuto por Número
                  </CardTitle>
                  <CardDescription className="text-xs text-muted-foreground mt-0.5">
                    Vazão instantânea minuto a minuto (view <code>wacrm.dispatch_throughput_per_minute</code>).
                  </CardDescription>
                </div>
                {channels.length > 0 && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {channels.map((ch, idx) => (
                      <span key={ch.id} className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <span
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: PALETTE[idx % PALETTE.length] }}
                          aria-hidden="true"
                        />
                        <span>{ch.label}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              {throughputSeries.length === 0 ? (
                <div className="flex h-64 items-center justify-center text-xs text-muted-foreground border border-dashed border-border rounded-lg">
                  Sem dados de envio no intervalo selecionado.
                </div>
              ) : (
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={throughputSeries} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                      <XAxis
                        dataKey="displayTime"
                        tick={{ fontSize: 11 }}
                        stroke="currentColor"
                        opacity={0.5}
                      />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        stroke="currentColor"
                        opacity={0.5}
                        allowDecimals={false}
                      />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          borderColor: "hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                        }}
                        labelStyle={{ fontWeight: "bold", marginBottom: "4px" }}
                      />
                      <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "12px" }} />
                      {channelDataKeys.map((keyName, idx) => (
                        <Line
                          key={keyName}
                          type="monotone"
                          dataKey={keyName}
                          name={keyName}
                          stroke={PALETTE[idx % PALETTE.length]}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 3. TABELA DOS ÚLTIMOS 20 TICKS */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                    <Activity className="size-4 text-primary" />
                    Últimos 20 Ticks do Disparador
                  </CardTitle>
                  <CardDescription className="text-xs text-muted-foreground mt-0.5">
                    Detalhamento dos ticks por minuto gravados em <code>wacrm.system_logs</code>.
                    Destaques automáticos em amarelo (atenção) e vermelho (crítico) para desvios operacionais.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-emerald-500" /> Normal
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-amber-500" /> Atenção
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-rose-500" /> Crítico
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="text-xs uppercase bg-muted/30">
                      <TableHead className="font-semibold">Horário</TableHead>
                      <TableHead className="font-semibold text-right">Duração</TableHead>
                      <TableHead className="font-semibold text-right">Enviados</TableHead>
                      <TableHead className="font-semibold text-right">Falhas/Adiados</TableHead>
                      <TableHead className="font-semibold text-right">Meta p95</TableHead>
                      <TableHead className="font-semibold text-right">Lag p99</TableHead>
                      <TableHead className="font-semibold text-right">Memória RSS</TableHead>
                      <TableHead className="font-semibold text-right">Vagas</TableHead>
                      <TableHead className="font-semibold text-center">Freio</TableHead>
                      <TableHead className="font-semibold">Erros Provedor</TableHead>
                      <TableHead className="font-semibold text-center">Saúde</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="text-xs divide-y divide-border">
                    {ticks.map((row) => {
                      const evalStatus = row.evaluation.status;
                      const hasRateErrors = Object.keys(row.rateErrors).length > 0;

                      return (
                        <TableRow
                          key={row.id}
                          className={cn(
                            "transition-colors",
                            evalStatus === "critical"
                              ? "bg-rose-500/[0.04] hover:bg-rose-500/[0.08]"
                              : evalStatus === "warning"
                              ? "bg-amber-500/[0.04] hover:bg-amber-500/[0.08]"
                              : "hover:bg-muted/30"
                          )}
                        >
                          {/* Horário */}
                          <TableCell className="font-mono text-foreground font-medium whitespace-nowrap">
                            {new Date(row.createdAt).toLocaleTimeString("pt-BR")}
                          </TableCell>

                          {/* Duração */}
                          <TableCell className="text-right whitespace-nowrap">
                            <span className="text-foreground">
                              {(row.durationMs / 1000).toFixed(1)}s
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-1">
                              / {Math.round(row.budgetMs / 1000)}s
                            </span>
                          </TableCell>

                          {/* Enviados */}
                          <TableCell className="text-right font-semibold text-foreground">
                            {row.sent > 0 ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                                {row.sent}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>

                          {/* Falhas / Adiados */}
                          <TableCell className="text-right whitespace-nowrap">
                            {row.failed > 0 ? (
                              <span className="text-destructive font-medium">{row.failed}</span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                            <span className="text-muted-foreground mx-1">/</span>
                            <span className="text-muted-foreground">{row.deferred}</span>
                          </TableCell>

                          {/* Meta p95 (Destaque amarelo > 1500, vermelho > 2000) */}
                          <TableCell
                            className={cn(
                              "text-right font-mono whitespace-nowrap",
                              row.evaluation.metaLatencyCritical
                                ? "font-bold text-rose-600 dark:text-rose-400 bg-rose-500/10 px-2 rounded"
                                : row.evaluation.metaLatencyWarning
                                ? "font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 rounded"
                                : "text-foreground"
                            )}
                          >
                            {row.metaP95Ms > 0 ? `${row.metaP95Ms} ms` : "—"}
                          </TableCell>

                          {/* Lag p99 (Destaque amarelo > 50, vermelho > 100) */}
                          <TableCell
                            className={cn(
                              "text-right font-mono whitespace-nowrap",
                              row.evaluation.lagCritical
                                ? "font-bold text-rose-600 dark:text-rose-400 bg-rose-500/10 px-2 rounded"
                                : row.evaluation.lagWarning
                                ? "font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 rounded"
                                : "text-foreground"
                            )}
                          >
                            {row.lagP99Ms} ms
                          </TableCell>

                          {/* Memória RSS (Destaque amarelo > 500, vermelho > 600) */}
                          <TableCell
                            className={cn(
                              "text-right font-mono whitespace-nowrap",
                              row.evaluation.rssCritical
                                ? "font-bold text-rose-600 dark:text-rose-400 bg-rose-500/10 px-2 rounded"
                                : row.evaluation.rssWarning
                                ? "font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 rounded"
                                : "text-foreground"
                            )}
                          >
                            {row.rssMb} MB
                            {row.rssPeakMb > row.rssMb && (
                              <span className="text-[10px] text-muted-foreground ml-1">
                                (pico {row.rssPeakMb})
                              </span>
                            )}
                          </TableCell>

                          {/* Concorrência / Vagas */}
                          <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                            <span className="text-foreground font-medium">{row.peakInFlight}</span>
                            <span> / {row.globalConcurrency}</span>
                          </TableCell>

                          {/* Freio / Backoff */}
                          <TableCell className="text-center whitespace-nowrap">
                            {row.evaluation.brakeTriggered ? (
                              <Badge variant="destructive" className="text-[10px] px-1.5 py-0 font-normal">
                                Acionado ({row.backoffEventsCount || 1})
                              </Badge>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">Livre</span>
                            )}
                          </TableCell>

                          {/* Erros de Provedor */}
                          <TableCell className="whitespace-nowrap">
                            {hasRateErrors ? (
                              <div className="flex flex-wrap gap-1">
                                {Object.entries(row.rateErrors).map(([code, count]) => (
                                  <Badge
                                    key={code}
                                    variant="destructive"
                                    className="text-[10px] px-1.5 py-0"
                                    title={`Erro ${code} da Meta: ${count} ocorrência(s)`}
                                  >
                                    {code}: {count}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>

                          {/* Status de Saúde */}
                          <TableCell className="text-center whitespace-nowrap">
                            {evalStatus === "critical" ? (
                              <Badge
                                variant="destructive"
                                className="text-[10px] px-2 py-0.5 gap-1 font-semibold"
                                title={row.evaluation.warnings.join(" | ")}
                              >
                                <AlertTriangle className="size-3" />
                                Crítico
                              </Badge>
                            ) : evalStatus === "warning" ? (
                              <Badge
                                className="bg-amber-500 text-white dark:bg-amber-600 text-[10px] px-2 py-0.5 gap-1 font-medium"
                                title={row.evaluation.warnings.join(" | ")}
                              >
                                <Info className="size-3" />
                                Atenção
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5 text-[10px] px-2 py-0.5 gap-1"
                              >
                                <CheckCircle2 className="size-3" />
                                Normal
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* 4. POR NÚMERO (channels{} do cron_tick) */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
                <Radio className="size-4 text-primary" />
                Por número na janela
              </CardTitle>
              <CardDescription className="mt-0.5 text-xs text-muted-foreground">
                Soma dos ciclos do motor por número: envios, falhas, adiados, pico em voo e freios.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto px-0 sm:px-6">
              {channelStats.length === 0 ? (
                <p className="px-6 py-6 text-center text-sm text-muted-foreground">Nenhum envio por número na janela.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Número</TableHead>
                      <TableHead className="text-right">Enviados</TableHead>
                      <TableHead className="text-right">Falhas</TableHead>
                      <TableHead className="text-right">Adiados</TableHead>
                      <TableHead className="text-right">Pico em voo</TableHead>
                      <TableHead className="text-right">Vagas (início → menor)</TableHead>
                      <TableHead className="text-right">Ciclos com freio</TableHead>
                      <TableHead className="text-right">Ciclos em cooldown</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {channelStats.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>
                          <div className="font-medium">{c.label}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {c.provider === "meta" ? "API oficial (Meta)" : c.provider === "waha" ? "WAHA" : "—"} · {c.ticks} {c.ticks === 1 ? "ciclo" : "ciclos"}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{formatInt(c.sent)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", c.failed > 0 && "text-amber-700 dark:text-amber-300")}>{formatInt(c.failed)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatInt(c.deferred)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatInt(c.peakInFlight)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.concurrencyStart ?? "—"} → {c.concurrencyEndMin ?? "—"}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums", c.brakeTicks > 0 && "font-semibold text-rose-700 dark:text-rose-300")}>{formatInt(c.brakeTicks)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", c.cooldownTicks > 0 && "font-semibold text-rose-700 dark:text-rose-300")}>{formatInt(c.cooldownTicks)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {truncated && (truncated.ticks || truncated.throughput) && (
                <p className="px-6 pt-3 text-[11px] text-amber-700 dark:text-amber-300">
                  A janela é maior que o limite de leitura: os dados mais antigos foram omitidos (os mais recentes estão completos).
                </p>
              )}
            </CardContent>
          </Card>

          {/* 5. CAPACIDADE: TETO TEÓRICO × REAL (calculado dos limites e da latência atuais) */}
          {capacity && (
            <Card className="border-primary/20 bg-primary/[0.02] shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <Zap className="size-4 text-primary" />
                  Capacidade: teto teórico × real
                </CardTitle>
                <CardDescription className="mt-0.5 text-xs text-muted-foreground">
                  Calculado agora com as vagas e a latência medidas pelo motor — não é uma tabela fixa.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <div className="rounded-lg border border-border bg-card p-3">
                    <dt className="text-muted-foreground">Teto teórico por número</dt>
                    <dd className="mt-1 text-lg font-bold tabular-nums">
                      {capacity.theoreticalPerMinPerNumber ? `${formatInt(capacity.theoreticalPerMinPerNumber)}/min` : "—"}
                    </dd>
                    <dd className="text-[11px] text-muted-foreground">
                      {capacity.slotsPerNumber ?? "?"} vagas ÷ {capacity.latencySeconds.toLocaleString("pt-BR")} s × {capacity.budgetSeconds} s do ciclo
                    </dd>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3">
                    <dt className="text-muted-foreground">Real: média / pico</dt>
                    <dd className="mt-1 text-lg font-bold tabular-nums">
                      {formatInt(capacity.realAvgPerMin)} / {formatInt(capacity.realPeakPerMin)}
                    </dd>
                    <dd className="text-[11px] text-muted-foreground">envios por minuto, todos os números</dd>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3">
                    <dt className="text-muted-foreground">Uso do teto (número mais ativo)</dt>
                    <dd className="mt-1 text-lg font-bold tabular-nums">{capacity.utilizationPct != null ? `${capacity.utilizationPct}%` : "—"}</dd>
                    <dd className="text-[11px] text-muted-foreground">perto de 100% = falta vaga, não demanda</dd>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3">
                    <dt className="text-muted-foreground">Vagas para 80 envios/s</dt>
                    <dd className="mt-1 text-lg font-bold tabular-nums">{capacity.slotsFor80PerSecond ?? "—"}</dd>
                    <dd className="text-[11px] text-muted-foreground">
                      por número, com esta latência e o tempo ativo do ciclo
                    </dd>
                  </div>
                </dl>
                {capacity.above50SlotCap && (
                  <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-amber-900 dark:text-amber-200">
                    <Info className="mt-0.5 size-4 shrink-0" />
                    <p>
                      80 envios/s por número exige mais de 50 vagas, e hoje o limite do sistema é de 50 vagas por número e 50 no total. Para chegar lá
                      é preciso elevar esses limites e encadear os ciclos do motor (etapa de capacidade do plano); subir só a configuração não basta.
                    </p>
                  </div>
                )}
                <p className="text-muted-foreground">
                  Suba a velocidade em degraus e confira este painel por 15–30 min em horário de pico. Volte um degrau se aparecerem freios, erros de limite
                  da Meta (429, 130429, 131048, 131056), lag do servidor acima de 100 ms ou memória acima de 600 MB.
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
