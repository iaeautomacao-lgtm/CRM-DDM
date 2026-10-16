"use client";

import { Fragment, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, Download, Info, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState } from "@/components/ddm/states";
import { KpiStrip } from "@/components/ddm/kpi-strip";
import { Segmented } from "@/components/ddm/segmented";
import { DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import {
  AI_COST_ESTIMATE_FALLBACK_NOTICE,
  featureLabel,
  formatInt,
  formatUsd,
  hasFeatureView,
  modelsOfFeature,
  monthLabel,
  rowAmountLabel,
  type AiCostReport,
  type CostGrouping,
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
  const [groupingChoice, setGroupingChoice] = useState<CostGrouping>("modelo");
  // Rota antiga (sem by_feature): só a visão por modelo.
  const featureView = hasFeatureView(report);
  const grouping: CostGrouping = featureView ? groupingChoice : "modelo";

  return (
    <div className="flex flex-col gap-4">
      <EstimateNotice notice={report?.notice} />

      <div className="flex flex-wrap items-end gap-3">
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
        {featureView ? (
          <div className="space-y-1">
            <span id="custos-ia-agrupar" className="block text-xs font-medium text-muted-foreground">
              Agrupar por
            </span>
            <Segmented<CostGrouping>
              ariaLabel="Agrupar custos por"
              value={groupingChoice}
              onChange={setGroupingChoice}
              options={[
                { value: "modelo", label: "Modelo" },
                { value: "funcionalidade", label: "Funcionalidade" },
              ]}
            />
          </div>
        ) : null}
        <Button className="ml-auto" variant="outline" onClick={onExportCsv} disabled={exporting || failed || loading}>
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

          <CostTable report={report} loading={loading} month={month} grouping={grouping} />
        </>
      )}
    </div>
  );
}

interface CostLine {
  key: string;
  label: string;
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  priced_usd: number;
  unpriced: number;
  children?: CostLine[];
}

function AmountCell({ row }: { row: CostLine }) {
  const label = rowAmountLabel(row);
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {row.unpriced > 0 && row.unpriced < row.requests ? (
        <Badge variant="outline" title="Chamadas sem tarifa na data não entram no valor">
          {formatInt(row.unpriced)} sem tarifa
        </Badge>
      ) : null}
      <span className={label === "Sem tarifa" ? "text-warning" : undefined}>{label}</span>
    </span>
  );
}

function CostTable({ report, loading, month, grouping }: { report: AiCostReport | undefined; loading: boolean; month: string; grouping: CostGrouping }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const lines: CostLine[] = useMemo(() => {
    if (!report) return [];
    if (grouping === "funcionalidade" && report.by_feature) {
      return report.by_feature.map((f) => ({
        ...f,
        key: f.feature,
        label: featureLabel(f.feature),
        children: modelsOfFeature(report.by_feature_model, f.feature).map((m) => ({ ...m, key: `${f.feature}|${m.sku}`, label: m.sku })),
      }));
    }
    return report.ai.map((r) => ({ ...r, key: r.sku, label: r.sku }));
  }, [report, grouping]);

  const byFeature = grouping === "funcionalidade";

  return (
    <TableCard
      title={`${byFeature ? "Por funcionalidade" : "Por modelo"} — ${monthLabel(month)}`}
      hint="Tarifa configurada × tokens informados pelo provedor. O custo da Meta (campanhas) fica em Campanhas · Desempenho."
    >
      {!loading && report && lines.length === 0 ? (
        <EmptyState icon={Info} title="Nenhum uso de IA registrado neste mês." />
      ) : (
        <DenseTable minWidth={720}>
          <thead>
            <tr>
              <Th>{byFeature ? "Funcionalidade" : "Modelo"}</Th>
              <Th align="right">Chamadas</Th>
              <Th align="right">Entrada</Th>
              <Th align="right">Em cache</Th>
              <Th align="right">Saída</Th>
              <Th align="right">Valor estimado</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((row) => {
              const expandable = (row.children?.length ?? 0) > 0;
              const expanded = expandable && open[row.key] === true;
              return (
                <Fragment key={row.key}>
                  <Tr interactive={false}>
                    <Td className="font-medium text-foreground">
                      {expandable ? (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setOpen((o) => ({ ...o, [row.key]: !expanded }))}
                          className="inline-flex items-center gap-1.5 rounded-sm text-left font-medium hover:text-primary-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                          title="Ver por modelo"
                        >
                          <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
                          {row.label}
                        </button>
                      ) : (
                        row.label
                      )}
                    </Td>
                    <Td align="right">{formatInt(row.requests)}</Td>
                    <Td align="right">{formatInt(row.input_tokens)}</Td>
                    <Td align="right">{formatInt(row.cached_input_tokens)}</Td>
                    <Td align="right">{formatInt(row.output_tokens)}</Td>
                    <Td align="right">
                      <AmountCell row={row} />
                    </Td>
                  </Tr>
                  {expanded
                    ? row.children?.map((c) => (
                        <Tr key={c.key} interactive={false} className="bg-muted/40">
                          <Td className="pl-10 text-foreground-2">{c.label}</Td>
                          <Td align="right">{formatInt(c.requests)}</Td>
                          <Td align="right">{formatInt(c.input_tokens)}</Td>
                          <Td align="right">{formatInt(c.cached_input_tokens)}</Td>
                          <Td align="right">{formatInt(c.output_tokens)}</Td>
                          <Td align="right">
                            <AmountCell row={c} />
                          </Td>
                        </Tr>
                      ))
                    : null}
                </Fragment>
              );
            })}
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
  );
}
