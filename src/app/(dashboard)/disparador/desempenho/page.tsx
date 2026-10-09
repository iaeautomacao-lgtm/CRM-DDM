"use client";

// /disparador/desempenho — telemetria do motor (ao vivo a cada ~3 s + histórico por tick a cada 30 s).
// Visual do redesenho DDM: faixa de indicadores, painéis e tabelas densas; dados, limites e textos
// operacionais inalterados (as flags `truncated` continuam avisando quando a janela foi cortada).

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Info,
  Megaphone,
  Radio,
  RefreshCw,
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
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { KpiStrip } from "@/components/ddm/kpi-strip";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { Segmented } from "@/components/ddm/segmented";
import { StatusChip } from "@/components/ddm/status-chip";
import { DenseTable, Td, Th, Tr } from "@/components/ddm/table-card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ddm/states";
import type { Capacity, ChannelStats } from "@/lib/disparador/desempenho-extra";
import { formatInt } from "@/lib/disparador/monitor-format";
import type {
  ChannelInfo,
  DesempenhoWindow,
  FormattedTickRow,
  ThroughputDataPoint,
  WindowMetricsSummary,
} from "@/lib/disparador/desempenho";

type PerfTone = "default" | "ok" | "warn" | "bad";

/** Célula da faixa de indicadores (desenho do KpiStrip, com fundo de alerta e linha de apoio). */
function PerfKpi(props: { title: string; value: ReactNode; sub?: ReactNode; tone?: PerfTone }) {
  const tone = props.tone ?? "default";
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 bg-card px-4 py-3.5",
        tone === "bad" && "bg-danger-soft",
        tone === "warn" && "bg-warning-soft",
      )}
    >
      <span className="flex items-center gap-1.5 text-[12.5px] text-foreground-2">
        {tone !== "default" && (
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", tone === "bad" ? "bg-danger" : tone === "warn" ? "bg-warning" : "bg-success")}
          />
        )}
        {props.title}
      </span>
      <span className="text-2xl font-semibold tracking-[-0.02em] tabular-nums text-foreground">{props.value}</span>
      {props.sub && <span className="text-xs text-muted-foreground">{props.sub}</span>}
    </div>
  );
}

// Painel do protótipo (borda 1px, raio 10px) com a mesma anatomia do Card antigo, para manter a marcação.
function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("flex flex-col overflow-hidden rounded-[10px] border border-border bg-card", className)} {...props} />;
}
function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-[18px] pb-2 pt-3.5", className)} {...props} />;
}
function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("m-0 font-sans text-sm font-semibold text-foreground", className)} {...props} />;
}
function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("m-0 text-[12.5px] text-muted-foreground", className)} {...props} />;
}
function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-[18px] pb-4", className)} {...props} />;
}

/** Chip de status no lugar do Badge antigo (texto + cor, tokens do tema). */
function Badge({
  variant,
  title,
  children,
}: {
  variant?: "destructive" | "outline" | "warning";
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <StatusChip tone={variant === "destructive" ? "bad" : variant === "warning" ? "warn" : "ok"} dot={false} title={title}>
      {children}
    </StatusChip>
  );
}

const WINDOW_OPTIONS: Array<{ key: DesempenhoWindow; label: string }> = [
  { key: "15m", label: "Últimos 15 min" },
  { key: "1h", label: "Última 1 hora" },
  { key: "6h", label: "Últimas 6 horas" },
  { key: "24h", label: "Últimas 24 horas" },
];

const PALETTE = [
  "#FF5706", // Laranja DDM
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

  const lagTone: PerfTone =
    metrics?.latestLagP99 && metrics.latestLagP99 > 100 ? "bad" : metrics?.latestLagP99 && metrics.latestLagP99 > 50 ? "warn" : "default";
  const p95Tone: PerfTone =
    metrics?.latestMetaP95 && metrics.latestMetaP95 > 2000 ? "bad" : metrics?.latestMetaP95 && metrics.latestMetaP95 > 1500 ? "warn" : "default";
  const rssTone: PerfTone =
    metrics?.peakRssMb && metrics.peakRssMb > 600 ? "bad" : metrics?.peakRssMb && metrics.peakRssMb > 500 ? "warn" : "default";

  return (
    <PageBody>
      <PageToolbar
        actions={
          <>
            <label className="flex h-8 cursor-pointer items-center gap-2 rounded-[6px] border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label="Estado operacional a cada 3 segundos e histórico a cada 30 segundos"
              />
              <span className="flex items-center gap-1.5 tabular-nums">
                <span aria-hidden="true" className={cn("size-2 rounded-full", autoRefresh ? "animate-pulse bg-success" : "bg-muted-foreground")} />
                Ao vivo 3 s · histórico {autoRefresh ? `(${secondsUntilRefresh}s)` : "(pausado)"}
              </span>
            </label>
            <Button
              variant="outline"
              onClick={() => {
                void fetchData(true);
                void fetchLiveData();
              }}
              disabled={refreshing || loading}
            >
              <RefreshCw className={cn("size-3.5", (refreshing || loading) && "animate-spin")} aria-hidden="true" />
              Atualizar
            </Button>
          </>
        }
      >
        <Segmented
          size="lg"
          ariaLabel="Janela de tempo"
          value={janela}
          onChange={setJanela}
          options={WINDOW_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
        />
      </PageToolbar>

      <p className="m-0 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Estado operacional atualizado a cada ~3 s; saúde do processo e histórico consolidados por tick.
          {(lastRefreshedAt || lastLiveAt) && (
            <>
              {" "}Ao vivo: {lastLiveAt ? lastLiveAt.toLocaleTimeString("pt-BR") : "—"} · histórico:{" "}
              {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString("pt-BR") : "—"}
            </>
          )}
        </span>
        {metrics && (
          <span className="tabular-nums">
            {metrics.totalTicks} {metrics.totalTicks === 1 ? "minuto registrado" : "minutos registrados"} na janela de {janela}
          </span>
        )}
      </p>

      {live && (
        <KpiStrip
          ariaLabel="Estado operacional ao vivo"
          minWidth={160}
          items={[
            { label: "Campanhas ativas", value: live.activeCampaigns.toLocaleString("pt-BR") },
            { label: "A enviar", value: live.remaining.toLocaleString("pt-BR") },
            { label: "Processando agora", value: <span className="text-primary-text">{live.sending.toLocaleString("pt-BR")}</span> },
            { label: "Falhas na campanha ativa", value: (live.errors + live.blocked).toLocaleString("pt-BR") },
          ]}
        />
      )}

      {/* Estados de carregamento e erro */}
      {loading ? (
        <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Carregando métricas de desempenho">
          <Skeleton className="h-[104px] w-full rounded-[10px]" />
          <Skeleton className="h-72 w-full rounded-[10px]" />
        </div>
      ) : error ? (
        <ErrorState title="Não foi possível carregar a telemetria" hint={error} onRetry={() => void fetchData(false)} />
      ) : ticks.length === 0 && !(live && (live.activeCampaigns > 0 || live.sentLast60s > 0)) ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border bg-card px-6 py-10 text-center">
          <EmptyState
            className="min-h-0 border-0 bg-transparent p-0"
            icon={Megaphone}
            title="Nenhum tick registrado na janela selecionada"
            hint="O motor de disparo grava uma linha de telemetria por minuto em wacrm.system_logs durante a execução do cron. Tente uma janela maior ou inicie um disparo para observar os dados."
          />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setJanela("6h")}>
              Ver últimas 6 horas
            </Button>
            <Button variant="outline" onClick={() => setJanela("24h")}>
              Ver últimas 24 horas
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* 1. Indicadores da janela */}
          <section
            aria-label="Indicadores da janela"
            className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-px overflow-hidden rounded-[10px] border border-border bg-border"
          >
            <PerfKpi
              title="Envios / min"
              value={
                <>
                  {(live?.sentLast60s ?? metrics?.nowSent ?? 0).toLocaleString("pt-BR")}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">últimos 60 s</span>
                </>
              }
              sub={
                <>
                  Média: <strong className="text-foreground">{metrics?.avgSentPerMinute ?? 0}</strong>/min · Total:{" "}
                  {metrics?.totalSent.toLocaleString("pt-BR")}
                </>
              }
            />
            <PerfKpi
              title="Latência Meta (p95)"
              tone={p95Tone}
              value={metrics?.latestMetaP95 ? `${metrics.latestMetaP95.toLocaleString("pt-BR")} ms` : "—"}
              sub={
                <>
                  Média: <strong className="text-foreground">{metrics?.avgMetaP95 ?? 0} ms</strong> na janela
                </>
              }
            />
            <PerfKpi
              title="Lentidão do servidor (p99)"
              tone={lagTone}
              value={
                <>
                  {metrics?.latestLagP99 ?? 0}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">ms</span>
                </>
              }
              sub={
                <>
                  Pico: <strong className="text-foreground">{metrics?.peakLagP99 ?? 0} ms</strong> (corte: 200 ms)
                </>
              }
            />
            <PerfKpi
              title="Memória pico (RSS)"
              tone={rssTone}
              value={
                <>
                  {metrics?.peakRssMb ?? 0}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">MB</span>
                </>
              }
              sub={
                <>
                  Atual: <strong className="text-foreground">{metrics?.latestRssMb ?? 0} MB</strong> (corte: 1.024 MB)
                </>
              }
            />
            <PerfKpi
              title="Freio acionado?"
              tone={metrics?.hasBrakeTriggered ? "bad" : "ok"}
              value={
                <span className={metrics?.hasBrakeTriggered ? "text-danger" : "text-success"}>
                  {metrics?.hasBrakeTriggered ? "Sim" : "Não"}
                </span>
              }
              sub={
                metrics?.hasBrakeTriggered
                  ? `${metrics.totalBackoffEvents} evento(s) de redução`
                  : "Fluxo desimpedido (sem recuo)"
              }
            />
            <PerfKpi
              title="Configuração ativa"
              value={
                <>
                  {metrics?.activeKnobs?.global_concurrency ?? 12}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">vagas globais</span>
                </>
              }
              sub={
                <span className="block truncate">
                  Meta: <strong className="text-foreground">{metrics?.activeKnobs?.per_number?.meta ?? 12}</strong> · WAHA:{" "}
                  {metrics?.activeKnobs?.per_number?.waha ?? 2} · Orç: {Math.round((metrics?.budgetMs ?? 35000) / 1000)}s
                </span>
              }
            />
          </section>


          {/* Alerta consolidado se houver erros 429 ou backoff ativo */}
          {(metrics?.hasBrakeTriggered || (metrics?.rateLimitErrorsTotal ?? 0) > 0) && (
            <div className="rounded-lg bg-warning-soft p-3.5 text-xs text-foreground flex items-start gap-2.5">
              <AlertTriangle className="size-4 shrink-0 text-warning mt-0.5" />
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
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="size-3.5 text-primary-text" aria-hidden="true" />
                    Envios por Minuto por Número
                  </CardTitle>
                  <CardDescription className="mt-0.5">
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
                <div className="flex h-64 items-center justify-center text-xs text-muted-foreground rounded-lg bg-surface-3">
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
                          backgroundColor: "var(--popover)",
                          borderColor: "var(--border)",
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
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="size-3.5 text-primary-text" aria-hidden="true" />
                    Últimos 20 Ticks do Disparador
                  </CardTitle>
                  <CardDescription className="mt-0.5">
                    Detalhamento dos ticks por minuto gravados em <code>wacrm.system_logs</code>.
                    Destaques automáticos em amarelo (atenção) e vermelho (crítico) para desvios operacionais.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-success" /> Normal
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-warning" /> Atenção
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-danger" /> Crítico
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <div className="overflow-x-auto">
                <DenseTable minWidth={900}>
                  <thead>
                    <tr>
                      <Th className="font-semibold">Horário</Th>
                      <Th className="font-semibold text-right">Duração</Th>
                      <Th className="font-semibold text-right">Enviados</Th>
                      <Th className="font-semibold text-right">Falhas/Adiados</Th>
                      <Th className="font-semibold text-right">Meta p95</Th>
                      <Th className="font-semibold text-right">Lag p99</Th>
                      <Th className="font-semibold text-right">Memória RSS</Th>
                      <Th className="font-semibold text-right">Vagas</Th>
                      <Th className="font-semibold text-center">Freio</Th>
                      <Th className="font-semibold">Erros Provedor</Th>
                      <Th className="font-semibold text-center">Saúde</Th>
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {ticks.map((row) => {
                      const evalStatus = row.evaluation.status;
                      const hasRateErrors = Object.keys(row.rateErrors).length > 0;

                      return (
                        <Tr
                          key={row.id}
                          className={cn(
                            "transition-colors",
                            evalStatus === "critical"
                              ? "bg-danger-soft"
                              : evalStatus === "warning"
                              ? "bg-warning-soft"
                              : ""
                          )}
                        >
                          {/* Horário */}
                          <Td className="font-mono text-foreground font-medium whitespace-nowrap">
                            {new Date(row.createdAt).toLocaleTimeString("pt-BR")}
                          </Td>

                          {/* Duração */}
                          <Td className="text-right whitespace-nowrap">
                            <span className="text-foreground">
                              {(row.durationMs / 1000).toFixed(1)}s
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-1">
                              / {Math.round(row.budgetMs / 1000)}s
                            </span>
                          </Td>

                          {/* Enviados */}
                          <Td className="text-right font-semibold text-foreground">
                            {row.sent > 0 ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-primary-soft text-primary-text">
                                {row.sent}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </Td>

                          {/* Falhas / Adiados */}
                          <Td className="text-right whitespace-nowrap">
                            {row.failed > 0 ? (
                              <span className="text-danger font-medium">{row.failed}</span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                            <span className="text-muted-foreground mx-1">/</span>
                            <span className="text-muted-foreground">{row.deferred}</span>
                          </Td>

                          {/* Meta p95 (Destaque amarelo > 1500, vermelho > 2000) */}
                          <Td
                            className={cn(
                              "text-right font-mono whitespace-nowrap",
                              row.evaluation.metaLatencyCritical
                                ? "font-bold text-danger bg-danger-soft px-2 rounded"
                                : row.evaluation.metaLatencyWarning
                                ? "font-semibold text-warning bg-warning-soft px-2 rounded"
                                : "text-foreground"
                            )}
                          >
                            {row.metaP95Ms > 0 ? `${row.metaP95Ms} ms` : "—"}
                          </Td>

                          {/* Lag p99 (Destaque amarelo > 50, vermelho > 100) */}
                          <Td
                            className={cn(
                              "text-right font-mono whitespace-nowrap",
                              row.evaluation.lagCritical
                                ? "font-bold text-danger bg-danger-soft px-2 rounded"
                                : row.evaluation.lagWarning
                                ? "font-semibold text-warning bg-warning-soft px-2 rounded"
                                : "text-foreground"
                            )}
                          >
                            {row.lagP99Ms} ms
                          </Td>

                          {/* Memória RSS (Destaque amarelo > 500, vermelho > 600) */}
                          <Td
                            className={cn(
                              "text-right font-mono whitespace-nowrap",
                              row.evaluation.rssCritical
                                ? "font-bold text-danger bg-danger-soft px-2 rounded"
                                : row.evaluation.rssWarning
                                ? "font-semibold text-warning bg-warning-soft px-2 rounded"
                                : "text-foreground"
                            )}
                          >
                            {row.rssMb} MB
                            {row.rssPeakMb > row.rssMb && (
                              <span className="text-[10px] text-muted-foreground ml-1">
                                (pico {row.rssPeakMb})
                              </span>
                            )}
                          </Td>

                          {/* Concorrência / Vagas */}
                          <Td className="text-right whitespace-nowrap text-muted-foreground">
                            <span className="text-foreground font-medium">{row.peakInFlight}</span>
                            <span> / {row.globalConcurrency}</span>
                          </Td>

                          {/* Freio / Backoff */}
                          <Td className="text-center whitespace-nowrap">
                            {row.evaluation.brakeTriggered ? (
                              <Badge variant="destructive" className="text-[10px] px-1.5 py-0 font-normal">
                                Acionado ({row.backoffEventsCount || 1})
                              </Badge>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">Livre</span>
                            )}
                          </Td>

                          {/* Erros de Provedor */}
                          <Td className="whitespace-nowrap">
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
                          </Td>

                          {/* Status de Saúde */}
                          <Td className="text-center whitespace-nowrap">
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
                                variant="warning"
                                title={row.evaluation.warnings.join(" | ")}
                              >
                                <Info className="size-3" />
                                Atenção
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                
                              >
                                <CheckCircle2 className="size-3" />
                                Normal
                              </Badge>
                            )}
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </DenseTable>
              </div>
            </CardContent>
          </Card>

          {/* 4. POR NÚMERO (channels{} do cron_tick) */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Radio className="size-3.5 text-primary-text" aria-hidden="true" />
                Por número na janela
              </CardTitle>
              <CardDescription className="mt-0.5">
                Soma dos ciclos do motor por número: envios, falhas, adiados, pico em voo e freios.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto px-0 pb-0">
              {channelStats.length === 0 ? (
                <p className="m-0 px-[18px] py-6 text-center text-sm text-muted-foreground">Nenhum envio por número na janela.</p>
              ) : (
                <DenseTable minWidth={900}>
                  <thead>
                    <tr>
                      <Th>Número</Th>
                      <Th className="text-right">Enviados</Th>
                      <Th className="text-right">Falhas</Th>
                      <Th className="text-right">Adiados</Th>
                      <Th className="text-right">Pico em voo</Th>
                      <Th className="text-right">Vagas (início → menor)</Th>
                      <Th className="text-right">Ciclos com freio</Th>
                      <Th className="text-right">Ciclos em cooldown</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelStats.map((c) => (
                      <Tr key={c.id}>
                        <Td>
                          <div className="font-medium">{c.label}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {c.provider === "meta" ? "API oficial (Meta)" : c.provider === "waha" ? "WAHA" : "—"} · {c.ticks} {c.ticks === 1 ? "ciclo" : "ciclos"}
                          </div>
                        </Td>
                        <Td className="text-right tabular-nums font-semibold">{formatInt(c.sent)}</Td>
                        <Td className={cn("text-right tabular-nums", c.failed > 0 && "text-warning")}>{formatInt(c.failed)}</Td>
                        <Td className="text-right tabular-nums">{formatInt(c.deferred)}</Td>
                        <Td className="text-right tabular-nums">{formatInt(c.peakInFlight)}</Td>
                        <Td className="text-right tabular-nums">
                          {c.concurrencyStart ?? "—"} → {c.concurrencyEndMin ?? "—"}
                        </Td>
                        <Td className={cn("text-right tabular-nums", c.brakeTicks > 0 && "font-semibold text-danger")}>{formatInt(c.brakeTicks)}</Td>
                        <Td className={cn("text-right tabular-nums", c.cooldownTicks > 0 && "font-semibold text-danger")}>{formatInt(c.cooldownTicks)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </DenseTable>
              )}
              {truncated && (truncated.ticks || truncated.throughput) && (
                <p className="m-0 px-[18px] py-3 text-[11px] text-warning">
                  A janela é maior que o limite de leitura: os dados mais antigos foram omitidos (os mais recentes estão completos).
                </p>
              )}
            </CardContent>
          </Card>

          {/* 5. CAPACIDADE: TETO TEÓRICO × REAL (calculado dos limites e da latência atuais) */}
          {capacity && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Zap className="size-3.5 text-primary-text" aria-hidden="true" />
                  Capacidade: teto teórico × real
                </CardTitle>
                <CardDescription className="mt-0.5">
                  Calculado agora com as vagas e a latência medidas pelo motor — não é uma tabela fixa.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <div className="rounded-lg bg-surface-3 p-3">
                    <dt className="text-muted-foreground">Teto teórico por número</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                      {capacity.theoreticalPerMinPerNumber ? `${formatInt(capacity.theoreticalPerMinPerNumber)}/min` : "—"}
                    </dd>
                    <dd className="text-[11px] text-muted-foreground">
                      {capacity.slotsPerNumber ?? "?"} vagas ÷ {capacity.latencySeconds.toLocaleString("pt-BR")} s × {capacity.budgetSeconds} s do ciclo
                    </dd>
                  </div>
                  <div className="rounded-lg bg-surface-3 p-3">
                    <dt className="text-muted-foreground">Real: média / pico</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                      {formatInt(capacity.realAvgPerMin)} / {formatInt(capacity.realPeakPerMin)}
                    </dd>
                    <dd className="text-[11px] text-muted-foreground">envios por minuto, todos os números</dd>
                  </div>
                  <div className="rounded-lg bg-surface-3 p-3">
                    <dt className="text-muted-foreground">Uso do teto (número mais ativo)</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{capacity.utilizationPct != null ? `${capacity.utilizationPct}%` : "—"}</dd>
                    <dd className="text-[11px] text-muted-foreground">perto de 100% = falta vaga, não demanda</dd>
                  </div>
                  <div className="rounded-lg bg-surface-3 p-3">
                    <dt className="text-muted-foreground">Vagas para 80 envios/s</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{capacity.slotsFor80PerSecond ?? "—"}</dd>
                    <dd className="text-[11px] text-muted-foreground">
                      por número, com esta latência e o tempo ativo do ciclo
                    </dd>
                  </div>
                </dl>
                {capacity.above50SlotCap && (
                  <div className="flex gap-2 rounded-lg bg-warning-soft p-3 text-foreground">
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
    </PageBody>
  );
}
