"use client";

// /disparador/numeros — um card por número: ao vivo (snapshot do Monitor) + configuração (limites do canal).
// Só leitura; quem edita é a aba Controles. Qualidade e limite/s entram quando o PR do limite por qualidade
// (P1-5) for ligado: hoje mostram "em breve".

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, PauseCircle, Phone, RefreshCw } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatInt, NUMBER_STATUS_LABELS } from "@/lib/disparador/monitor-format";
import type { MonitorNumberRow, MonitorSnapshot } from "@/lib/disparador/monitor-snapshot";
import type { LimitsOverview, NumberLimits } from "@/lib/disparador/limits";

const LIVE_MS = 3000;
const CONFIG_MS = 15000;

const PROVIDER_LABEL = { meta: "API oficial (Meta)", waha: "WAHA", unknown: "Provedor não definido" } as const;
const STATUS_CLASS: Record<MonitorNumberRow["status"], string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  freio: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  cooldown: "border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-200",
  desligado: "border-border bg-muted text-muted-foreground",
};

async function getJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `Erro HTTP ${res.status}`);
  return body as T;
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-base font-bold tabular-nums">{value}</dd>
      {hint && <dd className="text-[10px] text-muted-foreground">{hint}</dd>}
    </div>
  );
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

  const live = new Map((snapshot?.numbers ?? []).map((n) => [n.id, n]));
  const numbers: NumberLimits[] = overview?.numbers ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-col justify-between gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl">
            <Phone className="h-6 w-6 text-primary" aria-hidden="true" />
            Números
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Situação ao vivo e limites de cada número. Para mudar vagas, limite por hora ou pausar, use a aba{" "}
            <Link href="/disparador/controles" className="text-primary hover:underline">
              Controles
            </Link>
            .
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => { void loadLive(); void loadConfig(); }}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden="true" />
          Atualizar
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-800 dark:text-rose-200">
          {error}
        </div>
      )}

      {loading && !overview ? (
        <div className="flex h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" /> Carregando…
        </div>
      ) : numbers.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Nenhum número cadastrado nesta conta.</CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {numbers.map((n) => {
            const l = live.get(n.id);
            const status = n.paused ? null : (l?.status ?? "ok");
            const rate = overview?.rate?.[n.id] ?? null;
            return (
              <li key={n.id}>
                <Card className={cn("h-full shadow-sm", n.paused && "border-amber-500/50")}>
                  <CardContent className="flex flex-col gap-3 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h2 className="text-base font-semibold">{n.label}</h2>
                        <p className="text-xs text-muted-foreground">{n.phone ?? "sem telefone"}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{PROVIDER_LABEL[n.provider]}</Badge>
                        {n.paused ? (
                          <Badge variant="outline" className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                            <PauseCircle className="h-3 w-3" aria-hidden="true" /> Pausado
                          </Badge>
                        ) : (
                          status && <Badge variant="outline" className={STATUS_CLASS[status]}>{NUMBER_STATUS_LABELS[status]}</Badge>
                        )}
                        {!n.enabled && <Badge variant="outline">Desabilitado</Badge>}
                      </div>
                    </div>

                    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Stat label="Em voo agora" value={l ? formatInt(l.inFlight) : "—"} />
                      <Stat label="Envios por min" value={l ? formatInt(l.sent1m) : "—"} hint={l ? `média 15 min: ${formatInt(l.avgPerMin15)}` : undefined} />
                      <Stat
                        label="Vagas"
                        value={n.effectiveMaxInFlight}
                        hint={n.hasRow ? "definido no número" : "padrão do provedor"}
                      />
                      <Stat label="Limite por hora" value={n.hourlyLimit === null ? "sem limite" : formatInt(n.hourlyLimit)} />
                    </dl>

                    <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                      <div>
                        <dt className="text-muted-foreground">Qualidade da Meta</dt>
                        <dd className="font-medium">{rate?.quality ?? "em breve"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Limite por segundo</dt>
                        <dd className="font-medium">
                          {rate?.effectivePerSecond != null
                            ? `${rate.effectivePerSecond}/s (${rate.manualPerSecond != null ? "manual" : "automático"})`
                            : "em breve"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Na fila</dt>
                        <dd className="font-medium">{l?.queued != null ? `${formatInt(l.queued)}${l.queuedCapped ? "+" : ""}` : "—"}</dd>
                      </div>
                    </dl>

                    <div className="text-xs">
                      <span className="text-muted-foreground">Campanhas em execução: </span>
                      {n.activeCampaigns.length === 0 ? (
                        <span>nenhuma</span>
                      ) : (
                        n.activeCampaigns.map((c, i) => (
                          <span key={c.id}>
                            {i > 0 && ", "}
                            <Link href={`/disparador/campanhas/${c.id}`} className="text-primary hover:underline">
                              {c.nome}
                            </Link>
                          </span>
                        ))
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
