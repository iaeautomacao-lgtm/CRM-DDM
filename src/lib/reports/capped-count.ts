// Total com teto para listas paginadas de relatório ("100 mil+"), no mesmo espírito do teto do disparador
// (wacrm.dispatch_live_counts, migration 198). `count: 'exact'` varre TODAS as linhas do filtro; aqui o custo tem teto:
//   1. página curta (menos linhas que o pageSize, com alguma linha ou na página 1): o total é exato e sai de graça, sem consulta extra;
//   2. senão, sonda a linha de posição `cap` (range(cap, cap)): existe ⇒ total = cap e total_capped = true;
//   3. senão há no máximo `cap` linhas: contagem exata (barata por ser limitada).
// Resposta ADITIVA: `total` continua existindo; as métricas e os filtros não mudam.

export const REPORT_COUNT_CAP = 100_000

export interface CappedTotal {
  total: number
  /** true quando há `cap` ou mais linhas (mostrar "100 mil+"). */
  total_capped: boolean
  total_cap: number
}

type Probe = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
type Exact = () => PromiseLike<{ count: number | null; error: { message: string } | null }>

export async function cappedTotal(args: {
  /** Linhas da página já buscada (a página de dados que a rota devolve). */
  pageRows: number
  fromRow: number
  pageSize: number
  /** Mesmo filtro da lista, select('id') e range(from, to). */
  probe: Probe
  /** Mesmo filtro da lista, select('id', { count: 'exact', head: true }). */
  exact: Exact
  cap?: number
}): Promise<CappedTotal> {
  const cap = args.cap ?? REPORT_COUNT_CAP
  const shortPage = args.pageRows < args.pageSize && (args.pageRows > 0 || args.fromRow === 0)
  if (shortPage) {
    const total = args.fromRow + args.pageRows
    return total > cap
      ? { total: cap, total_capped: true, total_cap: cap }
      : { total, total_capped: false, total_cap: cap }
  }

  const probe = await args.probe(cap, cap)
  if (probe.error) throw new Error(probe.error.message)
  if ((probe.data?.length ?? 0) > 0) return { total: cap, total_capped: true, total_cap: cap }

  const exact = await args.exact()
  if (exact.error) throw new Error(exact.error.message)
  return { total: Math.min(exact.count ?? 0, cap), total_capped: false, total_cap: cap }
}
