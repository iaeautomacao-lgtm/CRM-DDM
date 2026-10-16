"use client";

import { useMemo } from "react";
import { useApiSWR } from "@/lib/swr";
import { buildSlaConfig, type SlaConfig, type SlaConfigResponse } from "@/lib/sla/config";

/**
 * SLA de primeira resposta por equipe (GET /api/sla/config, qualquer membro). Cache SWR em memória por conta/usuário;
 * enquanto carrega ou se falhar, vale o padrão (15 min). O objeto só muda quando a resposta muda, então listas
 * memoizadas que o recebem não renderizam à toa.
 */
export function useSlaConfig(): SlaConfig {
  const { data } = useApiSWR<SlaConfigResponse>("/api/sla/config", {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  return useMemo(() => buildSlaConfig(data), [data]);
}
