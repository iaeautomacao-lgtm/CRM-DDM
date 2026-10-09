// Rótulo e paginação do total com teto ("100 mil+") das listas de relatório (contrato: total, total_capped, total_cap das rotas
// GET /api/monitoramento/conversations e GET /api/audit-logs). Puro e seguro para componente client.

/** "100 mil+" quando o teto foi atingido; senão o número exato em pt-BR. */
export function formatCappedTotal(total: number, capped: boolean, cap: number): string {
  if (!capped) return total.toLocaleString("pt-BR");
  return cap % 1000 === 0 ? `${(cap / 1000).toLocaleString("pt-BR")} mil+` : `${cap.toLocaleString("pt-BR")}+`;
}

/** Número de páginas. Com teto, `total` já vem igual ao teto: a paginação não passa dele. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** Lê os campos aditivos da resposta; rotas antigas (sem os campos) valem como "sem teto". */
export function readCappedTotal(json: { total?: number; total_capped?: boolean; total_cap?: number } | null | undefined): {
  total: number;
  capped: boolean;
  cap: number;
} {
  return { total: json?.total ?? 0, capped: json?.total_capped === true, cap: json?.total_cap ?? 100_000 };
}
