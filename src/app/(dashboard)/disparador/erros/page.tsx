"use client";

// /disparador/erros — placeholder da tela de erros (a tela completa, com filtros por campanha/número/
// período e ações em lote seguras, vem depois). Já entrega o essencial: erros dos últimos 15 min
// agrupados pelo código da Meta, com "o que significa / o que fazer" (catálogo único) e o link da lista de
// itens de cada campanha JÁ filtrada por erro_codigo.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MonitorSnapshot } from "@/lib/disparador/monitor-snapshot";
import { classeLabelPt, errorItemsHref, formatInt, timeAgoPt } from "@/lib/disparador/monitor-format";

const POLL_MS = 10_000;

export default function ErrosPage() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await apiFetch("/api/disparador/monitor/snapshot");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Erro HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Resposta inválida do servidor");
      setSnapshot(data.snapshot as MonitorSnapshot);
      setLastOkAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar os erros");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(interval);
      clearInterval(tick);
    };
  }, [load]);

  const errors = snapshot?.errors ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 lg:p-6">
      <div className="flex flex-col justify-between gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl">
            <AlertTriangle className="h-6 w-6 text-primary" aria-hidden="true" />
            Erros do disparador
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Erros dos últimos 15 minutos por código da Meta. A lista completa com filtros por campanha, número e período e as ações em lote
            (reenviar/cancelar com segurança) chegam na próxima etapa.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden="true" />
          Atualizar
        </Button>
      </div>

      <p className="-mt-3 text-xs text-muted-foreground" aria-live="polite">
        {lastOkAt ? `Atualizado ${timeAgoPt(Math.round((clock - lastOkAt) / 1000))}` : "Carregando…"}
      </p>

      {error && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-800 dark:text-rose-200">
          Não foi possível carregar os erros: {error}.
        </div>
      )}

      {loading && !snapshot ? (
        <div className="flex h-48 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" /> Carregando…
        </div>
      ) : errors.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Nenhum erro nos últimos 15 minutos.</CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {errors.map((e) => (
            <li key={String(e.code)}>
              <Card className="shadow-sm">
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-sm">
                        {e.code ?? "sem código"}
                      </Badge>
                      <CardDescription className="text-xs">{classeLabelPt(e.classe)}</CardDescription>
                    </div>
                    <CardTitle className="text-base tabular-nums">
                      {formatInt(e.count)} <span className="text-xs font-normal text-muted-foreground">({e.pct.toLocaleString("pt-BR")}%)</span>
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div>
                    <p className="text-xs font-semibold">O que significa</p>
                    <p className="text-muted-foreground">{e.significado}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold">O que fazer</p>
                    <p className="text-muted-foreground">{e.acao}</p>
                  </div>
                  {e.campaigns.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-semibold">Itens com este erro, por campanha</p>
                      <ul className="flex flex-col gap-1 text-sm">
                        {e.campaigns.map((c) => (
                          <li key={c.id}>
                            <Link href={errorItemsHref(c.id, e.code)} className="text-primary hover:underline">
                              {c.nome} — {formatInt(c.count)} {c.count === 1 ? "item" : "itens"} (abrir lista filtrada)
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
