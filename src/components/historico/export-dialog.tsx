"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import { format } from "date-fns";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusChip } from "@/components/ddm/status-chip";
import {
  EXPORT_STATE_LABEL,
  EXPORT_STATE_TONE,
  buildHistoryExportBody,
  isExportActive,
  type ExportJobState,
} from "@/lib/historico/export-client";

interface ExportJob {
  id: string;
  period_from: string;
  period_to: string;
  tabulacao_id: string | null;
  state: ExportJobState;
  rows_done: number;
  total_rows: number | null;
  progress: number | null;
  truncated: boolean;
  created_at: string;
  error: string | null;
}

const ALL = "__all__";
const POLL_MS = 4000;

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}

/** Último dia incluído (o fim do pedido é exclusivo). */
function lastIncludedDay(iso: string): string {
  return fmtDay(new Date(new Date(iso).getTime() - 1).toISOString());
}

export function HistoryExportDialog({
  open,
  onOpenChange,
  tags,
  defaultTabulacaoId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: { id: string; name: string }[];
  defaultTabulacaoId: string | null;
}) {
  const today = format(new Date(), "yyyy-MM-dd");
  const weekAgo = format(new Date(Date.now() - 6 * 86_400_000), "yyyy-MM-dd");
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [tabulacao, setTabulacao] = useState<string>(ALL);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [jobsError, setJobsError] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Ao abrir, o filtro de tabulação da tela vira o padrão do pedido.
  useEffect(() => {
    if (open) setTabulacao(defaultTabulacaoId ?? ALL);
  }, [open, defaultTabulacaoId]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await apiFetch("/api/historico/exports", { cache: "no-store" });
      if (!res.ok) throw new Error("falha");
      const data = (await res.json()) as { jobs?: ExportJob[] };
      setJobs(data.jobs ?? []);
      setJobsError(false);
    } catch {
      setJobsError(true);
    }
  }, []);

  useEffect(() => {
    if (open) void loadJobs();
  }, [open, loadJobs]);

  // Enquanto algo está na fila ou gerando, consulta de novo.
  const hasActive = jobs.some((j) => isExportActive(j.state));
  useEffect(() => {
    if (!open || !hasActive) return;
    const t = setInterval(() => void loadJobs(), POLL_MS);
    return () => clearInterval(t);
  }, [open, hasActive, loadJobs]);

  async function submit() {
    const built = buildHistoryExportBody(from, to, tabulacao === ALL ? null : tabulacao);
    if (!built.ok) {
      toast.error(built.error);
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/historico/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "Não foi possível pedir a exportação");
        return;
      }
      toast.success("Exportação pedida. Ela aparece abaixo e fica pronta em instantes.");
      await loadJobs();
    } catch {
      toast.error("Não foi possível conectar ao servidor");
    } finally {
      setSubmitting(false);
    }
  }

  async function download(job: ExportJob) {
    setDownloadingId(job.id);
    try {
      const res = await apiFetch(`/api/historico/exports/${job.id}?download=1`, { cache: "no-store" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.download?.url) {
        toast.error(payload.error || "Arquivo indisponível");
        return;
      }
      window.open(payload.download.url as string, "_blank", "noopener,noreferrer");
    } catch {
      toast.error("Não foi possível conectar ao servidor");
    } finally {
      setDownloadingId(null);
    }
  }

  const tagName = (id: string | null) => (id ? tags.find((t) => t.id === id)?.name ?? "Tabulação" : "Todas as tabulações");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <div className="shrink-0 space-y-4 border-b border-border px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="font-heading text-lg">Exportar histórico</DialogTitle>
            <DialogDescription>
              Gera um arquivo CSV com as conversas encerradas no período (até 366 dias por exportação), por todas as tabulações ou só por uma.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hx-from">De</Label>
              <Input id="hx-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hx-to">Até</Label>
              <Input id="hx-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Tabulação</Label>
            <Select value={tabulacao} onValueChange={(v) => v && setTabulacao(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: string) => (v === ALL ? "Todas as tabulações" : tagName(v))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas as tabulações</SelectItem>
                {tags.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4">
          <h3 className="text-sm font-semibold text-foreground">Últimas exportações</h3>
          {jobsError ? (
            <p className="text-sm text-muted-foreground">Não foi possível carregar as exportações.</p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma exportação do histórico ainda.</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
              {jobs.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {fmtDay(j.period_from)} a {lastIncludedDay(j.period_to)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {tagName(j.tabulacao_id)}
                      {isExportActive(j.state) && j.progress != null ? ` · ${Math.round(j.progress * 100)}%` : ""}
                      {j.state === "done" ? ` · ${j.rows_done.toLocaleString("pt-BR")} conversas` : ""}
                      {j.state === "done" && j.truncated ? " (limite de linhas atingido)" : ""}
                    </p>
                  </div>
                  <StatusChip tone={EXPORT_STATE_TONE[j.state]}>{EXPORT_STATE_LABEL[j.state]}</StatusChip>
                  {j.state === "done" && (
                    <Button size="sm" variant="outline" disabled={downloadingId === j.id} onClick={() => void download(j)}>
                      {downloadingId === j.id ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                      Baixar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Os arquivos prontos também ficam em{" "}
            <Link href="/relatorios/exportacoes" className="text-primary underline underline-offset-2">
              Relatórios › Exportações
            </Link>
            .
          </p>
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border px-6 py-4 sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            Gerar exportação
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
