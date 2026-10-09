"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ddm/status-chip";
import { billingFetch } from "@/lib/billing/client-api";
import type { BillingAlert } from "@/lib/billing/client-types";

interface AlertsResponse {
  generated_at: string;
  alerts: BillingAlert[];
}

/**
 * Alertas da régua (GET /api/billing/alerts): sincronização, etapas presas, consultas adiadas e canal. A mensagem vem pronta
 * do servidor, em português. Lista vazia = tudo certo. Falha ao consultar não esconde problema: mostra aviso com atualizar.
 */
export function AlertsBanner() {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // A busca roda no efeito (setState só dentro dos callbacks); "Atualizar" só incrementa o tick.
  useEffect(() => {
    let cancelled = false;
    billingFetch<AlertsResponse>("/alerts")
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const load = useCallback(() => {
    setLoading(true);
    setTick((x) => x + 1);
  }, []);

  if (loading && !data) return null;

  if (failed) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-2.5 text-sm text-foreground-2">
        <AlertTriangle className="size-4 text-warning" aria-hidden />
        Não foi possível verificar os alertas da régua.
        <Button type="button" variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="size-3.5" />
          Tentar de novo
        </Button>
      </div>
    );
  }

  if (!data) return null;

  if (data.alerts.length === 0) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-success" aria-hidden />
        Sem alertas na régua.
      </p>
    );
  }

  return (
    <section aria-label="Alertas da régua" className="flex animate-ddm-fade flex-col gap-2">
      {data.alerts.map((a, i) => (
        <div
          key={`${a.code}-${i}`}
          role="alert"
          className={
            a.severity === "critical"
              ? "flex flex-wrap items-center gap-2 rounded-[10px] bg-danger-soft px-4 py-2.5 text-sm text-danger"
              : "flex flex-wrap items-center gap-2 rounded-[10px] bg-warning-soft px-4 py-2.5 text-sm text-warning"
          }
        >
          <StatusChip tone={a.severity === "critical" ? "bad" : "warn"}>{a.severity === "critical" ? "Crítico" : "Atenção"}</StatusChip>
          <span className="min-w-0 flex-1">{a.message}</span>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={load} disabled={loading}>
        <RefreshCw className="size-3.5" />
        Atualizar alertas
      </Button>
    </section>
  );
}
