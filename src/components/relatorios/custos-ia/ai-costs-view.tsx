"use client";

import { AlertTriangle, Download, Info, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState } from "@/components/ddm/states";
import { KpiStrip } from "@/components/ddm/kpi-strip";
import { DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import {
  AI_COST_ESTIMATE_FALLBACK_NOTICE,
  formatInt,
  formatUsd,
  monthLabel,
  rowAmountLabel,
  type AiCostReport,
} from "@/lib/costs/ai-costs-ui";

/** Aviso fixo: o valor é estimativa, não fatura. Aparece sempre, mesmo sem dados. */
export function EstimateNotice({ notice }: { notice?: string }) {
  return (
    <Alert variant="warning" aria-label="Aviso: valores estimados">
      <AlertTriangle />
      <AlertTitle>Estimativa, não é a fatura</AlertTitle>
      <AlertDescription className="text-foreground-2">{notice || AI_COST_ESTIMATE_FALLBACK_NOTICE}</AlertDescription>
    </Alert>
  );
}

export function AiCostsView({
  month,
  months,
  onMonthChange,
  report,
  loading,
  error,
  onRetry,
  onExportCsv,
  exporting,
}: {
  month: string;
  months: string[];
  onMonthChange: (month: string) => void;
  report: AiCostReport | undefined;
  loading: boolean;
  error: Error | undefined;
  onRetry: () => void;
  onExportCsv: () => void;
  exporting: boolean;
}) {
  const failed = error !== undefined && report === undefined;
  const totals = report?.totals;
  const hasUnpriced = (totals?.unpriced ?? 0) > 0;

  return (
    <div className="flex flex-col gap-4">
      <EstimateNotice notice={report?.notice} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <label htmlFor="custos-ia-mes" className="text-xs font-medium text-muted-foreground">
            Mês
          </label>
          <Select value={month} onValueChange={(v) => v && onMonthChange(v)}>
            <SelectTrigger id="custos-ia-mes" className="w-52">
              <SelectValue>{(v: string) => monthLabel(v)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={onExportCsv} disabled={exporting || failed || loading}>
          {exporting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          Exportar CSV
        </Button>
      </div>

      {failed ? (
        <ErrorState title="Não foi possível carregar os custos de IA" onRetry={onRetry} />
      ) : (
        <>
          <KpiStrip
            ariaLabel="Totais do mês"
            loading={loading && !report}
            items={[
              {
                label: "Custo estimado (USD)",
                value: formatUsd(totals?.priced_usd ?? 0),
                note: hasUnpriced ? `+ ${formatInt(totals?.unpriced ?? 0)} sem tarifa` : undefined,
                noteTone: hasUnpriced ? "warn" : undefined,
                info: "Soma só das chamadas que têm tarifa cadastrada. Chamadas sem tarifa não entram no valor: aparecem como “sem tarifa”.",
              },
              { label: "Chamadas", value: formatInt(totals?.requests ?? 0) },
              { label: "Tokens de entrada", value: formatInt(totals?.input_tokens ?? 0), note: `${formatInt(totals?.cached_input_tokens ?? 0)} em cache`, noteTone: "muted" },
              { label: "Tokens de saída", value: formatInt(totals?.output_tokens ?? 0) },
            ]}
          />

          <TableCard
            title={`Por modelo — ${monthLabel(month)}`}
            hint="Tarifa configurada × tokens informados pelo provedor. O custo da Meta (campanhas) fica em Campanhas · Desempenho."
          >
            {!loading && report && report.ai.length === 0 ? (
              <EmptyState icon={Info} title="Nenhum uso de IA registrado neste mês." />
            ) : (
              <DenseTable minWidth={720}>
                <thead>
                  <tr>
                    <Th>Modelo</Th>
                    <Th align="right">Chamadas</Th>
                    <Th align="right">Entrada</Th>
                    <Th align="right">Em cache</Th>
                    <Th align="right">Saída</Th>
                    <Th align="right">Valor estimado</Th>
                  </tr>
                </thead>
                <tbody>
                  {(report?.ai ?? []).map((row) => (
                    <Tr key={row.sku} interactive={false}>
                      <Td className="font-medium text-foreground">{row.sku}</Td>
                      <Td align="right">{formatInt(row.requests)}</Td>
                      <Td align="right">{formatInt(row.input_tokens)}</Td>
                      <Td align="right">{formatInt(row.cached_input_tokens)}</Td>
                      <Td align="right">{formatInt(row.output_tokens)}</Td>
                      <Td align="right">
                        <span className="inline-flex items-center justify-end gap-2">
                          {row.unpriced > 0 && row.unpriced < row.requests ? (
                            <Badge variant="outline" title="Chamadas sem tarifa na data não entram no valor">
                              {formatInt(row.unpriced)} sem tarifa
                            </Badge>
                          ) : null}
                          <span className={rowAmountLabel(row) === "Sem tarifa" ? "text-warning" : undefined}>{rowAmountLabel(row)}</span>
                        </span>
                      </Td>
                    </Tr>
                  ))}
                  {loading && !report
                    ? Array.from({ length: 3 }).map((_, i) => (
                        <tr key={i} aria-hidden="true">
                          <td colSpan={6} className="border-b border-border px-5 py-3.5">
                            <div className="h-4 w-full animate-pulse rounded bg-muted" />
                          </td>
                        </tr>
                      ))
                    : null}
                </tbody>
              </DenseTable>
            )}
          </TableCard>
        </>
      )}
    </div>
  );
}
