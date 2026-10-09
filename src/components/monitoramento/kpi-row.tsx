"use client";

import { KpiStrip, type KpiItem } from "@/components/ddm/kpi-strip";
import { PHASE_META } from "@/lib/monitoramento/phases";

interface KpiRowProps {
  total: number;
  navegando: number;
  espera: number;
  atendimento: number;
  loading: boolean;
}

/**
 * Faixa de KPIs ao vivo do Monitoramento (visual do protótipo DDM). Só
 * contagens reais das conversas abertas; os rótulos seguem as colunas de
 * fase (PHASE_META em src/lib/monitoramento/phases.ts).
 */
export function MonitorKpiRow({ total, navegando, espera, atendimento, loading }: KpiRowProps) {
  const items: KpiItem[] = [
    { label: "Total", value: total.toLocaleString("pt-BR") },
    { label: PHASE_META.navegando.label, value: navegando.toLocaleString("pt-BR") },
    { label: PHASE_META.espera.label, value: espera.toLocaleString("pt-BR") },
    { label: PHASE_META.atendimento.label, value: atendimento.toLocaleString("pt-BR") },
  ];
  return <KpiStrip items={items} loading={loading} ariaLabel="Conversas abertas por fase" />;
}
