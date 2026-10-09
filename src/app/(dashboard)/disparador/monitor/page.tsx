"use client";

// Monitor ao vivo do Disparador (P1-8). UM endpoint (/api/disparador/monitor/snapshot), polling de 3 s só
// com a aba visível. Mostra o que está acontecendo AGORA: envios/min × teto, fila restante e ETA, em voo,
// erros dos últimos 15 min com "o que significa / o que fazer", saúde do motor, números, campanhas e feed.
// Visual do redesenho DDM (faixa de KPIs, tabelas densas, chips de status); dados e textos vêm do servidor.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Info, Pause, RefreshCw, Siren } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ddm/states";
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
  critical: "bg-danger-soft text-foreground [&_svg]:text-danger",
  warning: "bg-warning-soft text-foreground [&_svg]:text-warning",
  info: "bg-surface-3 text-foreground [&_svg]:text-foreground-2",
};
const LEVEL_ICON: Record<AlertLevel, typeof Siren> = { critical: Siren, warning: AlertTriangle, info: Info };

type KpiTone = "default" | "warn" | "bad";

/** Célula da faixa de indicadores (mesmo desenho do KpiStrip, com barra de uso e linha de apoio). */
function MonitorKpi(props: { title: string; value: ReactNode; sub?: ReactNode; tone?: KpiTone; bar?: number | null }) {
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
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone === "bad" ? "bg-danger" : "bg-warning")} />
        )}
        {props.title}
      </span>
      <span className="text-2xl font-semibold tracking-[-0.02em] tabular-nums text-foreground">{props.value}</span>
      {props.bar != null && (
        <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="presentation">
          <span
            className={cn(
              "block h-full origin-left animate-ddm-bar rounded-full transition-[width] duration-500",
              props.bar >= 100 ? "bg-success" : "bg-primary",
            )}
            style={{ width: `${Math.max(2, Math.min(100, props.bar))}%` }}
          />
        </span>
      )}
      {props.sub && <span className="text-xs text-muted-foreground">{props.sub}</span>}
    </div>
  );
}

const NUMBER_TONE: Record<MonitorNumberRow["status"], StatusTone> = {
  ok: "ok",
  freio: "warn",
  cooldown: "bad",
  desligado: "mute",
};

function NumberStatusChip({ row }: { row: MonitorNumberRow }) {
  return <StatusChip tone={NUMBER_TONE[row.status]}>{NUMBER_STATUS_LABELS[row.status]}</StatusChip>;
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
  const liveOk = live && !stale && !error;

  return (
    <PageBody>
      <PageToolbar
        actions={
          <>
            <label className="flex h-8 cursor-pointer items-center gap-2 rounded-[6px] border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground">
              <Switch checked={live} onCheckedChange={setLive} aria-label="Atualização automática a cada 3 segundos" />
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn("size-2 rounded-full", liveOk ? "animate-pulse bg-success" : "bg-muted-foreground")}
                />
                {live ? "Ao vivo" : "Pausado"}
              </span>
            </label>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
              Atualizar
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 text-[15px] font-semibold text-foreground">Monitor ao vivo</h2>
          <p className="m-0 text-[12.5px] text-muted-foreground" aria-live="polite">
            {lastOkAt ? `Atualizado ${timeAgoPt(Math.round((clock - lastOkAt) / 1000))}` : "Carregando…"} · ritmo, fila,
            erros e saúde do motor; a cada 3 s com a aba aberta
            {stale && <span className="ml-1 font-semibold text-warning">· sem resposta do servidor há alguns segundos</span>}
          </p>
        </div>
      </PageToolbar>

      {error && (
        <div role="alert" className="flex animate-ddm-fade items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-2.5 text-[13px] text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <span>
            Não foi possível atualizar o monitor: {error}. {snapshot ? "Mostrando a última leitura." : ""}
          </span>
        </div>
      )}

      {loading && !s ? (
        <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Carregando monitor">
          <Skeleton className="h-[112px] w-full rounded-[10px]" />
          <Skeleton className="h-64 w-full rounded-[10px]" />
        </div>
      ) : !s ? (
        error ? <ErrorState title="Não foi possível carregar o monitor" onRetry={() => void load()} /> : null
      ) : (
        <>
          {/* Alertas */}
          {s.alerts.length > 0 && (
            <section aria-label="Alertas" className="flex flex-col gap-2">
              {s.alerts.map((a) => {
                const Icon = LEVEL_ICON[a.level];
                const content = (
                  <>
                    <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="m-0 text-[13px] font-semibold">{a.title}</p>
                      <p className="m-0 text-xs text-foreground-2">{a.detail}</p>
                    </div>
                  </>
                );
                return a.href ? (
                  <Link
                    key={a.id}
                    href={a.href}
                    className={cn("flex animate-ddm-fade gap-3 rounded-lg px-3.5 py-2.5 transition-opacity hover:opacity-90", LEVEL_STYLES[a.level])}
                  >
                    {content}
                  </Link>
                ) : (
                  <div key={a.id} className={cn("flex animate-ddm-fade gap-3 rounded-lg px-3.5 py-2.5", LEVEL_STYLES[a.level])}>
                    {content}
                  </div>
                );
              })}
            </section>
          )}

          {s.degraded.length > 0 && (
            <p className="m-0 rounded-lg bg-surface-3 px-3.5 py-2 text-xs text-foreground-2">
              Algumas fontes não responderam e o painel está parcial: {s.degraded.join("; ")}.
            </p>
          )}

          {/* Indicadores */}
          <section
            aria-label="Indicadores"
            className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-px overflow-hidden rounded-[10px] border border-border bg-border"
          >
            <MonitorKpi
              title="Envios por minuto (agora)"
              tone={engineDown ? "bad" : "default"}
              value={formatInt(s.totals.sentPerMin)}
              bar={s.totals.theoreticalPerMin ? (s.totals.sentPerMin / s.totals.theoreticalPerMin) * 100 : null}
              sub={
                <>
                  média 5 min: {formatInt(s.totals.sentPerMin5)}
                  {s.totals.theoreticalPerMin ? ` · teto teórico: ${formatInt(s.totals.theoreticalPerMin)}/min` : ""}
                </>
              }
            />
            <MonitorKpi
              title="Fila restante"
              value={formatInt(s.totals.queueRemaining)}
              sub={
                s.totals.runningCampaigns === 0
                  ? "Nenhuma campanha em execução"
                  : `ETA ${formatEtaPt(s.totals.etaMinutes)} · ${s.totals.runningCampaigns} ${s.totals.runningCampaigns === 1 ? "campanha" : "campanhas"}`
              }
            />
            <MonitorKpi
              title="Em voo agora"
              value={
                <>
                  {formatInt(s.totals.inFlight)}
                  <span className="text-base font-medium text-muted-foreground"> / {formatInt(s.totals.inFlightCap)}</span>
                </>
              }
              bar={s.totals.inFlightCap ? (s.totals.inFlight / s.totals.inFlightCap) * 100 : null}
              sub="envios simultâneos × vagas dos números"
            />
            <MonitorKpi
              title="Erros (últimos 15 min)"
              tone={s.totals.errorRatePct >= 30 && s.totals.errors15m >= 50 ? "bad" : s.totals.errors15m > 0 ? "warn" : "default"}
              value={formatInt(s.totals.errors15m)}
              sub={s.totals.errors15m > 0 ? `${s.totals.errorRatePct.toLocaleString("pt-BR")}% dos envios` : "Sem erros recentes"}
            />
            <MonitorKpi
              title="Motor de envio"
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
          <TableCard title="Por número" hint="Ritmo, vagas, fila e freio de cada número de envio.">
            {s.numbers.length === 0 ? (
              <EmptyState className="m-4 mt-0" title="Nenhum número cadastrado" />
            ) : (
              <DenseTable minWidth={760}>
                <thead>
                  <tr>
                    <Th>Número</Th>
                    <Th align="right">Envios/min</Th>
                    <Th align="right">Em voo / vagas</Th>
                    <Th align="right">Na fila</Th>
                    <Th align="right">ETA</Th>
                    <Th align="right">Teto teórico</Th>
                    <Th>Situação</Th>
                  </tr>
                </thead>
                <tbody>
                  {s.numbers.map((n) => (
                    <Tr key={n.id} className={cn(!n.enabled && "opacity-60")}>
                      <Td>
                        <CellMain
                          title={n.label}
                          sub={`${n.provider === "meta" ? "API oficial (Meta)" : n.provider === "waha" ? "WAHA" : "—"}${n.phone ? ` · ${n.phone}` : ""}`}
                        />
                      </Td>
                      <Td align="right">
                        <span className="block font-semibold text-foreground">{formatInt(n.sent1m)}</span>
                        <span className="block text-[11px] text-muted-foreground">média 5 min: {formatInt(n.sent5m / 5)}</span>
                      </Td>
                      <Td align="right">
                        {formatInt(n.inFlight)} / {formatInt(n.inFlightCap)}
                      </Td>
                      <Td align="right">{n.queued === null ? "—" : `${formatInt(n.queued)}${n.queuedCapped ? "+" : ""}`}</Td>
                      <Td align="right">{n.queued === null ? "—" : formatEtaPt(n.etaMinutes)}</Td>
                      <Td align="right">{n.theoreticalPerMin ? `${formatInt(n.theoreticalPerMin)}/min` : "—"}</Td>
                      <Td className="max-w-[16rem]">
                        <NumberStatusChip row={n} />
                        {(n.brake || n.cooldownUntil) && (
                          <p className="m-0 mt-1 whitespace-normal text-[11px] text-muted-foreground">
                            {n.cooldownUntil
                              ? `Cooldown até ${new Date(n.cooldownUntil).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. `
                              : ""}
                            {n.brake}
                          </p>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </DenseTable>
            )}
            {s.numbers.some((n) => n.queued === null && n.enabled) && (
              <p className="m-0 px-[18px] py-3 text-[11px] text-muted-foreground">
                &quot;Na fila&quot; por número aparece depois que o índice da migration 189b é criado; o restante total vem das campanhas.
              </p>
            )}
          </TableCard>

          {/* Por campanha */}
          <TableCard title="Campanhas" hint="Clique em uma campanha para ver os envios por contato.">
            {s.campaigns.length === 0 ? (
              <EmptyState className="m-4 mt-0" title="Nenhuma campanha em andamento" />
            ) : (
              <DenseTable minWidth={760}>
                <thead>
                  <tr>
                    <Th>Campanha</Th>
                    <Th className="min-w-[12rem]">Progresso</Th>
                    <Th align="right">Envios/min</Th>
                    <Th align="right">ETA</Th>
                    <Th align="right">Erros 15 min</Th>
                    <Th align="right">131026</Th>
                  </tr>
                </thead>
                <tbody>
                  {s.campaigns.map((c) => (
                    <Tr key={c.id} className="cursor-pointer" onClick={() => router.push(`/disparador/campanhas/${c.id}`)}>
                      <Td className="max-w-[18rem]">
                        <Link
                          href={`/disparador/campanhas/${c.id}`}
                          className="block truncate font-semibold text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.nome}
                        </Link>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          <StatusChip tone={c.status === "pausada" ? "bad" : c.status === "em_execucao" ? "ok" : "mute"}>
                            {c.status === "pausada" && <Pause className="size-3" aria-hidden="true" />}
                            {campaignStatusLabelPt(c.status)}
                          </StatusChip>
                          {c.numberLabels.length > 0 && <span className="truncate">{c.numberLabels.join(", ")}</span>}
                        </div>
                        {c.pauseReason && <p className="m-0 mt-1 whitespace-normal text-[11px] text-danger">{c.pauseReason}</p>}
                      </Td>
                      <Td>
                        <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="presentation">
                          <span
                            className="block h-full origin-left animate-ddm-bar rounded-full bg-primary transition-[width] duration-500"
                            style={{ width: `${Math.max(c.progressPct > 0 ? 2 : 0, c.progressPct)}%` }}
                          />
                        </span>
                        <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">
                          {c.progressPct.toLocaleString("pt-BR")}% · {formatInt(c.sent)} de {formatInt(c.total)} · faltam {formatInt(c.remaining)}
                        </span>
                      </Td>
                      <Td align="right">{c.status === "em_execucao" ? formatInt(c.ratePerMin) : "—"}</Td>
                      <Td align="right">{c.status === "em_execucao" ? formatEtaPt(c.etaMinutes) : "—"}</Td>
                      <Td align="right" className={cn(c.errors15m > 0 && "font-semibold text-warning")}>
                        {formatInt(c.errors15m)}
                      </Td>
                      <Td align="right">{c.pending131026 > 0 ? formatInt(c.pending131026) : "—"}</Td>
                    </Tr>
                  ))}
                </tbody>
              </DenseTable>
            )}
          </TableCard>

          <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
            {/* Erros por código */}
            <TableCard title="Erros dos últimos 15 minutos" hint="Agrupados pelo código da Meta, com o que significa e o que fazer.">
              {s.errors.length === 0 ? (
                <EmptyState className="m-4 mt-0" title="Nenhum erro nos últimos 15 minutos" />
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {s.errors.map((e) => (
                    <li key={String(e.code)} className="border-t border-border px-[18px] py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="rounded-[4px] bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-foreground">
                            {e.code ?? "sem código"}
                          </span>
                          <span className="text-xs text-muted-foreground">{classeLabelPt(e.classe)}</span>
                        </div>
                        <span className="text-[13px] font-semibold tabular-nums text-foreground">
                          {formatInt(e.count)}{" "}
                          <span className="text-xs font-normal text-muted-foreground">({e.pct.toLocaleString("pt-BR")}%)</span>
                        </span>
                      </div>
                      <dl className="m-0 mt-2 space-y-1.5 text-xs">
                        <div>
                          <dt className="font-semibold text-foreground">O que significa</dt>
                          <dd className="m-0 text-muted-foreground">{e.significado}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-foreground">O que fazer</dt>
                          <dd className="m-0 text-muted-foreground">{e.acao}</dd>
                        </div>
                      </dl>
                      {e.campaigns.length > 0 && (
                        <p className="m-0 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
                          {e.campaigns.map((c) => (
                            <Link key={c.id} href={errorItemsHref(c.id, e.code)} className="font-semibold text-primary-text hover:underline">
                              {c.nome} ({formatInt(c.count)}) — ver itens
                            </Link>
                          ))}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </TableCard>

            {/* Feed */}
            <TableCard title="Eventos recentes" hint="Pausas, freios, falhas e avisos do motor (últimas 24 h).">
              {s.events.length === 0 ? (
                <EmptyState className="m-4 mt-0" title="Nenhum evento recente" />
              ) : (
                <ol className="ddm-stagger m-0 flex list-none flex-col p-0">
                  {s.events.map((ev, i) => {
                    const Icon = LEVEL_ICON[ev.level];
                    return (
                      <li key={`${ev.at}-${ev.type}-${i}`} className="flex gap-3 border-t border-border px-[18px] py-2.5">
                        <span
                          className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3",
                            ev.level === "critical" ? "text-danger" : ev.level === "warning" ? "text-warning" : "text-foreground-2",
                          )}
                        >
                          <Icon className="size-3.5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="m-0 text-[13px] font-medium text-foreground">
                            {ev.campaignId ? (
                              <Link href={`/disparador/campanhas/${ev.campaignId}`} className="hover:underline">
                                {ev.title}
                              </Link>
                            ) : (
                              ev.title
                            )}
                          </p>
                          {ev.detail && <p className="m-0 text-xs text-muted-foreground">{ev.detail}</p>}
                        </div>
                        <time
                          className="shrink-0 text-xs tabular-nums text-muted-foreground"
                          dateTime={ev.at}
                          title={new Date(ev.at).toLocaleString("pt-BR")}
                        >
                          {timeAgoPt(secondsSince(ev.at, clock))}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              )}
            </TableCard>
          </div>

          <p className="m-0 text-xs text-muted-foreground">
            Itens em &quot;enviando&quot; há mais de 2 minutos são resolvidos automaticamente pelo sistema (sem reenvio, para nunca
            duplicar mensagem) e aparecem nos eventos acima.
          </p>
        </>
      )}
    </PageBody>
  );
}
