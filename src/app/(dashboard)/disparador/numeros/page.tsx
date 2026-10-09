"use client";

// /disparador/numeros — tabela de números (protótipo DDM "Números de envio"): ao vivo (snapshot do Monitor) +
// configuração (limites do canal). Só leitura; quem edita é a aba Controles. Qualidade e limite/s vêm do
// limite por qualidade da Meta (migration 190). Sem limite diário nem "enviados hoje": o modelo é por segundo.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, PauseCircle, RefreshCw } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { EmptyState, Skeleton } from "@/components/ddm/states";
import { formatInt, NUMBER_STATUS_LABELS } from "@/lib/disparador/monitor-format";
import type { MonitorNumberRow, MonitorSnapshot } from "@/lib/disparador/monitor-snapshot";
import type { LimitsOverview, NumberLimits } from "@/lib/disparador/limits";

const LIVE_MS = 3000;
const CONFIG_MS = 15000;

const PROVIDER_LABEL = { meta: "API oficial (Meta)", waha: "WAHA", unknown: "Provedor não definido" } as const;
const QUALITY_LABEL: Record<string, string> = { GREEN: "Verde", YELLOW: "Amarela", RED: "Vermelha", UNKNOWN: "Sem leitura" };
const QUALITY_COLOR: Record<string, string> = { GREEN: "text-success", YELLOW: "text-warning", RED: "text-danger" };
const STATUS_TONE: Record<MonitorNumberRow["status"], StatusTone> = {
  ok: "ok",
  freio: "warn",
  cooldown: "bad",
  desligado: "mute",
};

async function getJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `Erro HTTP ${res.status}`);
  return body as T;
}

export default function NumerosPage() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [overview, setOverview] = useState<LimitsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busyLive = useRef(false);
  const busyConfig = useRef(false);

  const loadLive = useCallback(async () => {
    if (busyLive.current) return;
    busyLive.current = true;
    try {
      const data = await getJson<{ snapshot: MonitorSnapshot }>("/api/disparador/monitor/snapshot");
      setSnapshot(data.snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o ao vivo");
    } finally {
      busyLive.current = false;
    }
  }, []);

  const loadConfig = useCallback(async () => {
    if (busyConfig.current) return;
    busyConfig.current = true;
    try {
      setOverview(await getJson<LimitsOverview>("/api/disparador/limits"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar os números");
    } finally {
      busyConfig.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLive();
    void loadConfig();
    const visible = () => document.visibilityState === "visible";
    const a = setInterval(() => visible() && void loadLive(), LIVE_MS);
    const b = setInterval(() => visible() && void loadConfig(), CONFIG_MS);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [loadLive, loadConfig]);

  // "Atualizar dados da Meta": re-consulta nome/telefone/qualidade agora (1 por minuto por conta), sem esperar o cron.
  const [metaRefreshing, setMetaRefreshing] = useState(false);
  const [metaMessage, setMetaMessage] = useState<string | null>(null);
  const refreshFromMeta = useCallback(async () => {
    setMetaRefreshing(true);
    setMetaMessage(null);
    try {
      const res = await apiFetch("/api/disparador/health/refresh", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { refreshed?: number; failed?: number; error?: string; retry_after_seconds?: number };
      if (res.status === 429) setMetaMessage(`Aguarde ${body.retry_after_seconds ?? 60} s para atualizar de novo.`);
      else if (!res.ok) setMetaMessage(body.error ?? "Falha ao atualizar os dados da Meta.");
      else setMetaMessage(body.failed ? `Atualizado: ${body.refreshed ?? 0} número(s); ${body.failed} falhou(aram).` : `Dados da Meta atualizados (${body.refreshed ?? 0} número(s)).`);
      await loadConfig();
      await loadLive();
    } catch {
      setMetaMessage("Falha ao atualizar os dados da Meta.");
    } finally {
      setMetaRefreshing(false);
    }
  }, [loadConfig, loadLive]);

  const live = new Map((snapshot?.numbers ?? []).map((n) => [n.id, n]));
  const numbers: NumberLimits[] = overview?.numbers ?? [];

  return (
    <PageBody>
      <PageToolbar
        actions={
          <>
            <Button variant="outline" disabled={metaRefreshing} onClick={() => void refreshFromMeta()}>
              <RefreshCw className={cn("size-3.5", metaRefreshing && "animate-spin")} aria-hidden="true" />
              Atualizar dados da Meta
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void loadLive();
                void loadConfig();
              }}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
              Atualizar
            </Button>
          </>
        }
      >
        <p className="m-0 text-[12.5px] text-muted-foreground">
          Situação ao vivo e limites de cada número. Para mudar vagas, limite por hora ou pausar, use a aba{" "}
          <Link href="/disparador/controles" className="font-semibold text-primary-text hover:underline">
            Controles
          </Link>
          .
        </p>
      </PageToolbar>

      {metaMessage && (
        <p role="status" className="m-0 animate-ddm-fade rounded-lg bg-surface-3 px-3.5 py-2 text-xs text-foreground-2">
          {metaMessage}
        </p>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-2.5 text-[13px] text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          {error}
        </div>
      )}

      <TableCard
        title="Números de envio"
        hint="Qualidade e limite por segundo informados pela Meta; vagas e limite por hora definidos em Controles."
      >
        {loading && !overview ? (
          <div className="flex flex-col gap-2 px-[18px] pb-4" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : numbers.length === 0 ? (
          <EmptyState className="m-4 mt-0" title="Nenhum número cadastrado nesta conta" />
        ) : (
          <DenseTable minWidth={980}>
            <thead>
              <tr>
                <Th>Número</Th>
                <Th>Qualidade</Th>
                <Th align="right">Limite por segundo</Th>
                <Th align="right">Vagas</Th>
                <Th align="right">Limite por hora</Th>
                <Th align="right">Em voo</Th>
                <Th align="right">Envios/min</Th>
                <Th align="right">Na fila</Th>
                <Th>Situação</Th>
              </tr>
            </thead>
            <tbody className="ddm-stagger">
              {numbers.map((n) => {
                const l = live.get(n.id);
                const status = n.paused ? null : (l?.status ?? "ok");
                const rate = overview?.rate?.[n.id] ?? null;
                const q = rate?.quality ?? null;
                return (
                  <Tr key={n.id} className={cn(!n.enabled && "opacity-60")}>
                    <Td className="max-w-[16rem]">
                      <CellMain title={n.label} sub={`${n.phone ?? "sem telefone"} · ${PROVIDER_LABEL[n.provider]}`} />
                      {n.activeCampaigns.length > 0 && (
                        <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                          Em execução:{" "}
                          {n.activeCampaigns.map((c, i) => (
                            <span key={c.id}>
                              {i > 0 && ", "}
                              <Link href={`/disparador/campanhas/${c.id}`} className="text-primary-text hover:underline">
                                {c.nome}
                              </Link>
                            </span>
                          ))}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {n.provider !== "meta" ? (
                        <span className="text-xs text-muted-foreground">não se aplica</span>
                      ) : q ? (
                        <span className={cn("inline-flex items-center gap-1.5 font-semibold", QUALITY_COLOR[q] ?? "text-muted-foreground")}>
                          <span aria-hidden="true" className="size-2 rounded-full bg-current" />
                          {QUALITY_LABEL[q] ?? q}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {overview?.rate == null ? "indisponível (migration 190)" : "sem leitura"}
                        </span>
                      )}
                    </Td>
                    <Td align="right">
                      {rate?.effectivePerSecond != null ? (
                        <>
                          <span className="block text-foreground">{rate.effectivePerSecond}/s</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {rate.manualPerSecond != null ? "manual" : "automático"}
                          </span>
                        </>
                      ) : n.provider === "meta" ? (
                        "—"
                      ) : (
                        <span className="text-xs text-muted-foreground">não se aplica (WAHA)</span>
                      )}
                    </Td>
                    <Td align="right">
                      <span className="block text-foreground">{n.effectiveMaxInFlight}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {n.hasRow ? "definido no número" : "padrão do provedor"}
                      </span>
                    </Td>
                    <Td align="right">{n.hourlyLimit === null ? "sem limite" : formatInt(n.hourlyLimit)}</Td>
                    <Td align="right">{l ? formatInt(l.inFlight) : "—"}</Td>
                    <Td align="right">
                      <span className="block text-foreground">{l ? formatInt(l.sent1m) : "—"}</span>
                      {l && <span className="block text-[11px] text-muted-foreground">média 15 min: {formatInt(l.avgPerMin15)}</span>}
                    </Td>
                    <Td align="right">{l?.queued != null ? `${formatInt(l.queued)}${l.queuedCapped ? "+" : ""}` : "—"}</Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {n.paused ? (
                          <StatusChip tone="warn">
                            <PauseCircle className="size-3" aria-hidden="true" /> Pausado
                          </StatusChip>
                        ) : (
                          status && <StatusChip tone={STATUS_TONE[status]}>{NUMBER_STATUS_LABELS[status]}</StatusChip>
                        )}
                        {n.connected === true && <StatusChip tone="ok">Conectado</StatusChip>}
                        {n.connected === false && (
                          <StatusChip tone="bad" title={n.connectionError ?? undefined}>
                            Desconectado
                          </StatusChip>
                        )}
                        {!n.enabled && <StatusChip tone="mute">Desabilitado</StatusChip>}
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </DenseTable>
        )}
      </TableCard>
    </PageBody>
  );
}
