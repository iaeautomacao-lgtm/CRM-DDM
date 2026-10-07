"use client";

// Monitor ao vivo do Disparador (P1-8). UM endpoint (/api/disparador/monitor/snapshot), polling de 3 s só
// com a aba visível. Mostra o que está acontecendo AGORA: envios/min × teto, fila restante e ETA, em voo,
// erros dos últimos 15 min com "o que significa / o que fazer", saúde do motor, números, campanhas e feed.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  Pause,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  Siren,
  Zap,
} from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { AlertLevel, MonitorNumberRow, MonitorSnapshot } from "@/lib/disparador/monitor-snapshot";
import {
  NUMBER_STATUS_LABELS,
  campaignStatusLabelPt,
  classeLabelPt,
  errorItemsHref,
  formatEtaPt,
  formatInt,
  secondsSince,
  timeAgoPt,
} from "@/lib/disparador/monitor-format";

const POLL_MS = 3000;

const LEVEL_STYLES: Record<AlertLevel, string> = {
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-200",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-900 dark:text-sky-200",
};
const LEVEL_ICON: Record<AlertLevel, typeof Siren> = { critical: Siren, warning: AlertTriangle, info: Info };

function Kpi(props: {
  title: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
  bar?: number | null;
}) {
  const tone = props.tone ?? "default";
  return (
    <Card
      className={cn(
        "shadow-sm",
        tone === "bad" && "border-rose-500/40 bg-rose-500/5",
        tone === "warn" && "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
        <CardTitle className="text-xs font-semibold text-muted-foreground">{props.title}</CardTitle>
        <span className="text-muted-foreground" aria-hidden="true">
          {props.icon}
        </span>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums tracking-tight">{props.value}</div>
        {props.bar != null && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
            <div
              className={cn("h-full rounded-full", props.bar >= 100 ? "bg-emerald-500" : "bg-primary")}
              style={{ width: `${Math.max(2, Math.min(100, props.bar))}%` }}
            />
          </div>
        )}
        {props.sub && <p className="mt-1.5 text-xs text-muted-foreground">{props.sub}</p>}
      </CardContent>
    </Card>
  );
}

function NumberStatusBadge({ row }: { row: MonitorNumberRow }) {
  const label = NUMBER_STATUS_LABELS[row.status];
  const cls =
    row.status === "ok"
      ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
      : row.status === "desligado"
        ? "border-border text-muted-foreground"
        : row.status === "cooldown"
          ? "border-rose-500/40 text-rose-700 dark:text-rose-300"
          : "border-amber-500/40 text-amber-700 dark:text-amber-300";
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap text-[11px]", cls)}>
      {label}
    </Badge>
  );
}

export default function MonitorV2Page() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await apiFetch("/api/disparador/monitor/snapshot");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Erro HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!mounted.current) return;
      if (!data.ok) throw new Error(data.error || "Resposta inválida do servidor");
      setSnapshot(data.snapshot as MonitorSnapshot);
      setLastOkAt(Date.now());
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Falha ao carregar o monitor");
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Primeira carga e polling de 3 s SÓ com a aba visível; ao voltar para a aba, atualiza na hora.
  useEffect(() => {
    void load();
    if (!live) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, load]);

  // Relógio de 1 s só para os textos "há X s".
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const stale = lastOkAt !== null && clock - lastOkAt > POLL_MS * 4;
  const s = snapshot;
  const engineDown = s?.engine.stale === true;
  const sentTone = !s ? "default" : engineDown ? "bad" : "default";

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 p-4 lg:p-6">
      {/* Cabeçalho */}
      <div className="flex flex-col justify-between gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl">
            <Activity className="h-6 w-6 text-primary" aria-hidden="true" />
            Monitor ao vivo
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            O que está acontecendo agora nos envios: ritmo, fila, erros e saúde do motor. Atualiza a cada 3 s com a aba aberta.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <Switch id="monitor-live" checked={live} onCheckedChange={setLive} className="scale-90" aria-label="Atualização automática a cada 3 segundos" />
            <Label htmlFor="monitor-live" className="flex cursor-pointer items-center gap-1.5 text-xs font-normal">
              <Radio className={cn("size-3.5", live && !stale && !error ? "animate-pulse text-emerald-500" : "text-muted-foreground")} aria-hidden="true" />
              {live ? "Ao vivo" : "Pausado"}
            </Label>
          </div>
          <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden="true" />
            Atualizar
          </Button>
        </div>
      </div>

      <p className="-mt-3 text-xs text-muted-foreground" aria-live="polite">
        {lastOkAt ? `Atualizado ${timeAgoPt(Math.round((clock - lastOkAt) / 1000))}` : "Carregando…"}
        {stale && <span className="ml-2 font-medium text-amber-600 dark:text-amber-400">· sem resposta do servidor há alguns segundos</span>}
      </p>

      {error && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-800 dark:text-rose-200">
          Não foi possível atualizar o monitor: {error}. {snapshot ? "Mostrando a última leitura." : ""}
        </div>
      )}

      {loading && !s ? (
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" /> Carregando monitor…
        </div>
      ) : !s ? null : (
        <>
          {/* Alertas */}
          {s.alerts.length > 0 && (
            <section aria-label="Alertas" className="flex flex-col gap-2">
              {s.alerts.map((a) => {
                const Icon = LEVEL_ICON[a.level];
                const content = (
                  <>
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{a.title}</p>
                      <p className="text-xs opacity-90">{a.detail}</p>
                    </div>
                  </>
                );
                return a.href ? (
                  <Link key={a.id} href={a.href} className={cn("flex gap-3 rounded-lg border px-4 py-3 hover:opacity-90", LEVEL_STYLES[a.level])}>
                    {content}
                  </Link>
                ) : (
                  <div key={a.id} className={cn("flex gap-3 rounded-lg border px-4 py-3", LEVEL_STYLES[a.level])}>
                    {content}
                  </div>
                );
              })}
            </section>
          )}

          {s.degraded.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
              Algumas fontes não responderam e o painel está parcial: {s.degraded.join("; ")}.
            </div>
          )}

          {/* Cards */}
          <section aria-label="Indicadores" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi
              title="Envios por minuto (agora)"
              icon={<Send className="h-4 w-4" />}
              tone={sentTone}
              value={formatInt(s.totals.sentPerMin)}
              bar={s.totals.theoreticalPerMin ? (s.totals.sentPerMin / s.totals.theoreticalPerMin) * 100 : null}
              sub={
                <>
                  média 5 min: {formatInt(s.totals.sentPerMin5)}
                  {s.totals.theoreticalPerMin ? ` · teto teórico: ${formatInt(s.totals.theoreticalPerMin)}/min` : ""}
                </>
              }
            />
            <Kpi
              title="Fila restante"
              icon={<Clock className="h-4 w-4" />}
              value={formatInt(s.totals.queueRemaining)}
              sub={
                s.totals.runningCampaigns === 0
                  ? "Nenhuma campanha em execução"
                  : `ETA ${formatEtaPt(s.totals.etaMinutes)} · ${s.totals.runningCampaigns} ${s.totals.runningCampaigns === 1 ? "campanha" : "campanhas"}`
              }
            />
            <Kpi
              title="Em voo agora"
              icon={<Zap className="h-4 w-4" />}
              value={
                <>
                  {formatInt(s.totals.inFlight)}
                  <span className="text-base font-medium text-muted-foreground"> / {formatInt(s.totals.inFlightCap)}</span>
                </>
              }
              bar={s.totals.inFlightCap ? (s.totals.inFlight / s.totals.inFlightCap) * 100 : null}
              sub="envios simultâneos × vagas dos números"
            />
            <Kpi
              title="Erros (últimos 15 min)"
              icon={<ShieldAlert className="h-4 w-4" />}
              tone={s.totals.errorRatePct >= 30 && s.totals.errors15m >= 50 ? "bad" : s.totals.errors15m > 0 ? "warn" : "default"}
              value={formatInt(s.totals.errors15m)}
              sub={s.totals.errors15m > 0 ? `${s.totals.errorRatePct.toLocaleString("pt-BR")}% dos envios` : "Sem erros recentes"}
            />
            <Kpi
              title="Motor de envio"
              icon={engineDown ? <Siren className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              tone={engineDown ? "bad" : "default"}
              value={engineDown ? "Parado" : s.engine.lastTickAt ? "Rodando" : "Ocioso"}
              sub={
                s.engine.lastTickAt
                  ? `último ciclo ${timeAgoPt(secondsSince(s.engine.lastTickAt, clock))}${s.engine.utilizationPct != null ? ` · ${s.engine.utilizationPct}% do tempo do ciclo` : ""}`
                  : "sem ciclos recentes"
              }
            />
          </section>

          {/* Por número */}
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Por número</CardTitle>
              <CardDescription className="text-xs">Ritmo, vagas, fila e freio de cada número de envio.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto px-0 sm:px-6">
              {s.numbers.length === 0 ? (
                <p className="px-6 py-6 text-center text-sm text-muted-foreground">Nenhum número cadastrado.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Número</TableHead>
                      <TableHead className="text-right">Envios/min</TableHead>
                      <TableHead className="text-right">Em voo / vagas</TableHead>
                      <TableHead className="text-right">Na fila</TableHead>
                      <TableHead className="text-right">ETA</TableHead>
                      <TableHead className="text-right">Teto teórico</TableHead>
                      <TableHead>Situação</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.numbers.map((n) => (
                      <TableRow key={n.id} className={cn(!n.enabled && "opacity-60")}>
                        <TableCell>
                          <div className="font-medium">{n.label}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {n.provider === "meta" ? "API oficial (Meta)" : n.provider === "waha" ? "WAHA" : "—"}
                            {n.phone ? ` · ${n.phone}` : ""}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <div className="font-semibold">{formatInt(n.sent1m)}</div>
                          <div className="text-[11px] text-muted-foreground">média 5 min: {formatInt(n.sent5m / 5)}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatInt(n.inFlight)} / {formatInt(n.inFlightCap)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {n.queued === null ? "—" : `${formatInt(n.queued)}${n.queuedCapped ? "+" : ""}`}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{n.queued === null ? "—" : formatEtaPt(n.etaMinutes)}</TableCell>
                        <TableCell className="text-right tabular-nums">{n.theoreticalPerMin ? `${formatInt(n.theoreticalPerMin)}/min` : "—"}</TableCell>
                        <TableCell className="max-w-[16rem]">
                          <NumberStatusBadge row={n} />
                          {(n.brake || n.cooldownUntil) && (
                            <p className="mt-1 whitespace-normal text-[11px] text-muted-foreground">
                              {n.cooldownUntil ? `Cooldown até ${new Date(n.cooldownUntil).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. ` : ""}
                              {n.brake}
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {s.numbers.some((n) => n.queued === null && n.enabled) && (
                <p className="px-6 pt-3 text-[11px] text-muted-foreground">
                  &quot;Na fila&quot; por número aparece depois que o índice da migration 189b é criado; o restante total vem das campanhas.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Por campanha */}
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Campanhas</CardTitle>
              <CardDescription className="text-xs">Clique em uma campanha para ver os envios por contato.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto px-0 sm:px-6">
              {s.campaigns.length === 0 ? (
                <p className="px-6 py-6 text-center text-sm text-muted-foreground">Nenhuma campanha em andamento.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campanha</TableHead>
                      <TableHead className="min-w-[10rem]">Progresso</TableHead>
                      <TableHead className="text-right">Envios/min</TableHead>
                      <TableHead className="text-right">ETA</TableHead>
                      <TableHead className="text-right">Erros 15 min</TableHead>
                      <TableHead className="text-right">131026</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.campaigns.map((c) => (
                      <TableRow
                        key={c.id}
                        className="cursor-pointer"
                        onClick={() => router.push(`/disparador/campanhas/${c.id}`)}
                      >
                        <TableCell className="max-w-[16rem]">
                          <Link
                            href={`/disparador/campanhas/${c.id}`}
                            className="block truncate font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {c.nome}
                          </Link>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            <Badge variant="outline" className={cn("text-[10px]", c.status === "pausada" && "border-rose-500/40 text-rose-700 dark:text-rose-300", c.status === "em_execucao" && "border-emerald-500/40 text-emerald-700 dark:text-emerald-300")}>
                              {c.status === "pausada" && <Pause className="mr-1 h-3 w-3" aria-hidden="true" />}
                              {campaignStatusLabelPt(c.status)}
                            </Badge>
                            {c.numberLabels.length > 0 && <span className="truncate">{c.numberLabels.join(", ")}</span>}
                          </div>
                          {c.pauseReason && <p className="mt-1 whitespace-normal text-[11px] text-rose-700 dark:text-rose-300">{c.pauseReason}</p>}
                        </TableCell>
                        <TableCell>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(c.progressPct > 0 ? 2 : 0, c.progressPct)}%` }} />
                          </div>
                          <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                            {c.progressPct.toLocaleString("pt-BR")}% · {formatInt(c.sent)} de {formatInt(c.total)} · faltam {formatInt(c.remaining)}
                          </p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{c.status === "em_execucao" ? formatInt(c.ratePerMin) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.status === "em_execucao" ? formatEtaPt(c.etaMinutes) : "—"}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", c.errors15m > 0 && "font-semibold text-amber-700 dark:text-amber-300")}>
                          {formatInt(c.errors15m)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{c.pending131026 > 0 ? formatInt(c.pending131026) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Erros por código */}
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Erros dos últimos 15 minutos</CardTitle>
              <CardDescription className="text-xs">Agrupados pelo código da Meta, com o que significa e o que fazer.</CardDescription>
            </CardHeader>
            <CardContent>
              {s.errors.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">Nenhum erro nos últimos 15 minutos.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {s.errors.map((e) => (
                    <li key={String(e.code)} className="rounded-lg border border-border bg-card p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono text-xs">
                            {e.code ?? "sem código"}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{classeLabelPt(e.classe)}</span>
                        </div>
                        <span className="text-sm font-semibold tabular-nums">
                          {formatInt(e.count)} <span className="text-xs font-normal text-muted-foreground">({e.pct.toLocaleString("pt-BR")}%)</span>
                        </span>
                      </div>
                      <dl className="mt-2 space-y-1.5 text-xs">
                        <div>
                          <dt className="font-semibold text-foreground">O que significa</dt>
                          <dd className="text-muted-foreground">{e.significado}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-foreground">O que fazer</dt>
                          <dd className="text-muted-foreground">{e.acao}</dd>
                        </div>
                      </dl>
                      {e.campaigns.length > 0 && (
                        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                          {e.campaigns.map((c) => (
                            <Link key={c.id} href={errorItemsHref(c.id, e.code)} className="text-primary hover:underline">
                              {c.nome} ({formatInt(c.count)}) — ver itens
                            </Link>
                          ))}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Feed */}
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Eventos recentes</CardTitle>
              <CardDescription className="text-xs">Pausas, freios, falhas e avisos do motor (últimas 24 h).</CardDescription>
            </CardHeader>
            <CardContent>
              {s.events.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">Nenhum evento recente.</p>
              ) : (
                <ol className="divide-y divide-border/60">
                  {s.events.map((ev, i) => {
                    const Icon = LEVEL_ICON[ev.level];
                    return (
                      <li key={`${ev.at}-${ev.type}-${i}`} className="flex gap-3 py-2.5">
                        <Icon
                          className={cn(
                            "mt-0.5 h-4 w-4 shrink-0",
                            ev.level === "critical" ? "text-rose-500" : ev.level === "warning" ? "text-amber-500" : "text-sky-500",
                          )}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            {ev.campaignId ? (
                              <Link href={`/disparador/campanhas/${ev.campaignId}`} className="hover:underline">
                                {ev.title}
                              </Link>
                            ) : (
                              ev.title
                            )}
                          </p>
                          {ev.detail && <p className="text-xs text-muted-foreground">{ev.detail}</p>}
                        </div>
                        <time className="shrink-0 text-xs text-muted-foreground" dateTime={ev.at} title={new Date(ev.at).toLocaleString("pt-BR")}>
                          {timeAgoPt(secondsSince(ev.at, clock))}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Itens em &quot;enviando&quot; há mais de 2 minutos são resolvidos automaticamente pelo sistema (sem reenvio, para nunca duplicar mensagem) e aparecem nos eventos acima.
          </p>
        </>
      )}
    </div>
  );
}
