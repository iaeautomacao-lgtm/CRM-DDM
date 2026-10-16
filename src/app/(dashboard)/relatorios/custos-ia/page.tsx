"use client";

// /relatorios/custos-ia — custo ESTIMADO de IA do mês e tarifas por vigência (migration 378).
// Rotas: GET /api/costs/ai?month=AAAA-MM (&format=csv) e GET/PUT /api/costs/ai/rates. O servidor exige reports.view_all
// (admin+) e, para gravar tarifa, settings.account; aqui só não se oferece o que daria 403. Não é fatura.

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api-fetch";
import { usePermissions } from "@/hooks/use-permission";
import { useApiSWR } from "@/lib/swr";
import {
  AI_RATES_PATH,
  costReportPath,
  currentMonthSP,
  monthOptions,
  type AiCostReport,
  type AiRatesResponse,
} from "@/lib/costs/ai-costs-ui";
import { Segmented } from "@/components/ddm/segmented";
import { ForbiddenState } from "@/components/ddm/states";
import { AiCostsView } from "@/components/relatorios/custos-ia/ai-costs-view";
import { AiRatesPanel } from "@/components/relatorios/custos-ia/ai-rates-panel";

type View = "custos" | "tarifas";

export default function CustosIaPage() {
  const { can, loading: permsLoading } = usePermissions();
  const canView = can("reports.view_all");
  const canEditRates = can("settings.account");

  const currentMonth = useMemo(() => currentMonthSP(), []);
  const months = useMemo(() => monthOptions(currentMonth), [currentMonth]);
  const [month, setMonth] = useState(currentMonth);
  const [view, setView] = useState<View>("custos");
  const [exporting, setExporting] = useState(false);

  const report = useApiSWR<AiCostReport>(costReportPath(month), { enabled: canView });
  const rates = useApiSWR<AiRatesResponse>(AI_RATES_PATH, { enabled: canView });

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await apiFetch(costReportPath(month, "csv"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `custos-ia-${month}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Não foi possível exportar o CSV.");
    } finally {
      setExporting(false);
    }
  }

  if (permsLoading) return null;
  if (!canView) return <ForbiddenState title="Você não tem permissão para ver os custos de IA" />;

  return (
    <div className="flex flex-col gap-4">
      <Segmented<View>
        ariaLabel="Seção de custos de IA"
        value={view}
        onChange={setView}
        options={[
          { value: "custos", label: "Custos do mês" },
          { value: "tarifas", label: "Tarifas" },
        ]}
      />
      {view === "custos" ? (
        <AiCostsView
          month={month}
          months={months}
          onMonthChange={setMonth}
          report={report.data}
          loading={report.isLoading}
          error={report.error}
          onRetry={() => void report.mutate()}
          onExportCsv={() => void exportCsv()}
          exporting={exporting}
        />
      ) : (
        <AiRatesPanel
          data={rates.data}
          loading={rates.isLoading}
          error={rates.error}
          onRetry={() => void rates.mutate()}
          canEdit={canEditRates}
          onSaved={() => Promise.all([rates.mutate(), report.mutate()])}
        />
      )}
    </div>
  );
}
