"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ddm/status-chip";
import type { BatchItemResult, BatchSummary } from "@/lib/monitoramento/batch-client";

/** Barra da seleção em massa (visual do protótipo DDM): contagem, ações e Limpar. */
export function BulkBar({
  count,
  busy,
  canTransfer,
  canFinalize,
  onTransfer,
  onFinalize,
  onClear,
}: {
  count: number;
  busy: boolean;
  canTransfer: boolean;
  canFinalize: boolean;
  onTransfer: () => void;
  onFinalize: () => void;
  onClear: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Ações em massa"
      className="flex animate-ddm-fade flex-wrap items-center gap-2.5 rounded-[10px] bg-foreground py-2.5 pl-4 pr-3 text-background"
    >
      <span className="text-[13px] font-semibold" aria-live="polite">
        {count} {count === 1 ? "conversa selecionada" : "conversas selecionadas"}
      </span>
      <span className="flex-1" />
      {canTransfer && (
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onTransfer}>
          Transferir para mim
        </Button>
      )}
      {canFinalize && (
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onFinalize}>
          Finalizar com tabulação
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" className="text-background hover:bg-background/15 hover:text-background" disabled={busy} onClick={onClear}>
        Limpar
      </Button>
    </div>
  );
}

export interface BatchReport {
  title: string;
  summary: BatchSummary;
  /** Itens que falharam, já com o nome do contato. */
  failures: Array<{ id: string; label: string; message: string }>;
  /** Erro da chamada inteira (ex.: sem permissão): o que ficou sem processar. */
  pendingCount: number;
  error: string | null;
}

export function failureMessage(r: BatchItemResult): string {
  if (r.code === "not_found") return "Conversa não encontrada ou sem acesso";
  return r.error || "Não foi possível concluir";
}

/** Resumo ok/falhou de uma ação em lote, com a lista dos itens que falharam. */
export function BatchReportPanel({ report, onDismiss }: { report: BatchReport; onDismiss: () => void }) {
  const { summary } = report;
  return (
    <section role="status" aria-label={report.title} className="flex animate-ddm-fade flex-col gap-2 rounded-[10px] border border-border bg-card px-4 py-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{report.title}</h3>
        <StatusChip tone="ok">{summary.ok} ok</StatusChip>
        <StatusChip tone={summary.failed > 0 ? "bad" : "mute"}>{summary.failed} falharam</StatusChip>
        {report.pendingCount > 0 && <StatusChip tone="warn">{report.pendingCount} sem processar</StatusChip>}
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Fechar resumo" onClick={onDismiss}>
          <X className="size-4" />
        </Button>
      </header>
      {report.error && <p className="text-xs text-danger">{report.error}</p>}
      {report.failures.length > 0 && (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
          {report.failures.map((f) => (
            <li key={f.id} className="flex flex-wrap gap-x-2">
              <span className="font-medium text-foreground">{f.label}</span>
              <span className="text-muted-foreground">{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      {report.failures.length > 0 && <p className="text-xs text-muted-foreground">Os itens que falharam continuam selecionados para tentar de novo.</p>}
    </section>
  );
}
