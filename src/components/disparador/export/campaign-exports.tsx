"use client";

// Exportação em segundo plano de uma campanha (docs/disparador-exportacao-assincrona.md): POST /api/disparador/exports
// cria (ou reaproveita) o job, o cron gera o CSV e o GET /exports/[id] acompanha; o download sai por um link assinado
// e curto (?download=1). Substitui o "Exportar" síncrono para bases grandes (PRD 22, PR 8).

import { useCallback, useEffect, useState } from "react";
import { Download, FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusChip } from "@/components/ddm/status-chip";
import {
  EXPORT_STATE_LABEL,
  EXPORT_STATUS_OPTIONS,
  exportDownloadable,
  exportStatusLabel,
  formatBytes,
  isActiveExport,
  type PublicExportJob,
} from "@/lib/disparador/import-client";

const POLL_MS = 2500;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Erro HTTP ${res.status}`);
  return body as T;
}

/** Pede o link assinado e abre o download. */
async function downloadExport(id: string) {
  try {
    const body = await getJson<{ download?: { url: string } }>(`/api/disparador/exports/${id}?download=1`);
    if (!body.download?.url) throw new Error("Link de download indisponível.");
    const a = document.createElement("a");
    a.href = body.download.url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Não foi possível baixar o arquivo.");
  }
}

/** Hook: exportações da campanha (últimas 20 da conta, filtradas) com acompanhamento automático das que estão rodando. */
export function useCampaignExports(campaignId: string | null) {
  const [jobs, setJobs] = useState<PublicExportJob[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(
    () =>
      campaignId
        ? getJson<{ jobs: PublicExportJob[]; unavailable?: boolean }>(
            `/api/disparador/exports?campaign_id=${encodeURIComponent(campaignId)}`,
          ).then(
            (body) => {
              setJobs(body.jobs);
              setUnavailable(!!body.unavailable);
            },
            () => setJobs((prev) => prev ?? []),
          )
        : Promise.resolve(),
    [campaignId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const hasActive = (jobs ?? []).some((j) => isActiveExport(j.state));
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [hasActive, load]);

  const request = useCallback(
    async (statusKey: string) => {
      if (!campaignId) return;
      try {
        await getJson("/api/disparador/exports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaign_id: campaignId, status: statusKey }),
        });
        toast.success("Exportação pedida. O arquivo fica pronto em segundo plano.");
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Não foi possível pedir a exportação.");
      }
    },
    [campaignId, load],
  );

  return { jobs, unavailable, request, reload: load };
}

/** Botão "Exportar CSV" de uma métrica: pede o job e mostra o progresso/baixar no lugar. */
export function ExportJobButton({ campaignId, statusKey }: { campaignId: string; statusKey: string }) {
  const { jobs, unavailable, request } = useCampaignExports(campaignId);
  const [asking, setAsking] = useState(false);
  const job = (jobs ?? []).find((j) => j.status_key === statusKey && j.state !== "expired" && j.state !== "cancelled");

  if (unavailable) return null;
  if (job && isActiveExport(job.state)) {
    const pct = job.progress != null ? Math.round(job.progress * 100) : null;
    return (
      <Button variant="outline" disabled aria-live="polite">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        Gerando CSV{pct != null ? ` ${pct}%` : "…"}
      </Button>
    );
  }
  if (job && exportDownloadable(job)) {
    return (
      <Button variant="outline" onClick={() => void downloadExport(job.id)}>
        <Download className="size-3.5" aria-hidden="true" /> Baixar CSV ({formatBytes(job.file_size)})
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      disabled={asking}
      onClick={async () => {
        setAsking(true);
        await request(statusKey);
        setAsking(false);
      }}
      title="Gera o arquivo em segundo plano; serve para bases grandes"
    >
      {asking ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <FileDown className="size-3.5" aria-hidden="true" />}
      Exportar CSV
    </Button>
  );
}

/** Painel "Exportações" da campanha: escolher a métrica, pedir e acompanhar/baixar os arquivos. */
export function CampaignExportsPanel({ campaignId }: { campaignId: string }) {
  const { jobs, unavailable, request } = useCampaignExports(campaignId);
  const [statusKey, setStatusKey] = useState("total");
  const [asking, setAsking] = useState(false);

  if (unavailable) return null;
  return (
    <section aria-label="Exportações" className="flex flex-col gap-3 rounded-[10px] border border-border bg-card px-[18px] py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="m-0 font-sans text-sm font-semibold text-foreground">Exportações</h3>
          <p className="m-0 text-[12.5px] text-muted-foreground">
            O arquivo é gerado em segundo plano e fica disponível para baixar por tempo limitado.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="export-status">
            Métrica para exportar
          </label>
          <select
            id="export-status"
            value={statusKey}
            onChange={(e) => setStatusKey(e.target.value)}
            className="h-8 rounded-[6px] border border-input bg-background px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {EXPORT_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <Button
            disabled={asking}
            onClick={async () => {
              setAsking(true);
              await request(statusKey);
              setAsking(false);
            }}
          >
            {asking ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <FileDown className="size-3.5" aria-hidden="true" />}
            Exportar CSV
          </Button>
        </div>
      </div>
      {jobs && jobs.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0" aria-live="polite">
          {jobs.slice(0, 6).map((j) => {
            const active = isActiveExport(j.state);
            const pct = j.state === "done" ? 100 : j.progress != null ? Math.round(j.progress * 100) : null;
            return (
              <li key={j.id} className="flex flex-col gap-1.5 border-t border-border py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-foreground">{exportStatusLabel(j.status_key)}</span>
                  <span className="flex items-center gap-2">
                    <StatusChip
                      tone={j.state === "done" ? "ok" : j.state === "failed" ? "bad" : active ? "brand" : "mute"}
                    >
                      {EXPORT_STATE_LABEL[j.state]}
                    </StatusChip>
                    {exportDownloadable(j) && (
                      <Button size="sm" variant="outline" onClick={() => void downloadExport(j.id)}>
                        <Download className="size-3.5" aria-hidden="true" /> Baixar
                      </Button>
                    )}
                  </span>
                </div>
                {active && (
                  <span
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct ?? undefined}
                    className="block h-1.5 overflow-hidden rounded-full bg-surface-3"
                  >
                    <span
                      className={cn("block h-full rounded-full bg-primary transition-[width] duration-500", pct == null && "w-1/3 animate-pulse")}
                      style={pct != null ? { width: `${pct}%` } : undefined}
                    />
                  </span>
                )}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {j.rows_done.toLocaleString("pt-BR")}
                  {j.total_rows != null ? ` de ${j.total_rows.toLocaleString("pt-BR")}` : ""} linhas
                  {j.file_size != null ? ` · ${formatBytes(j.file_size)}` : ""}
                  {j.truncated ? " · bateu no teto de 100.000 linhas: o arquivo pode estar incompleto" : ""}
                  {j.state === "done" && j.expires_at
                    ? ` · disponível até ${new Date(j.expires_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`
                    : ""}
                  {j.error ? ` · ${j.error}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
