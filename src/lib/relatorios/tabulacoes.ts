export interface TabulacaoRow {
  codigo_tabulacao: number | null;
  nome: string;
  total: number;
  human: number;
  ai_auto: number;
  automation: number;
  com_sugestao: number;
  aceitas: number;
  trocadas: number;
}

export type RawTabulacaoRow = Omit<
  TabulacaoRow,
  | 'total'
  | 'human'
  | 'ai_auto'
  | 'automation'
  | 'com_sugestao'
  | 'aceitas'
  | 'trocadas'
> &
  Record<
    | 'total'
    | 'human'
    | 'ai_auto'
    | 'automation'
    | 'com_sugestao'
    | 'aceitas'
    | 'trocadas',
    number | string
  >;

export function normalizeTabulacoes(rows: RawTabulacaoRow[]): TabulacaoRow[] {
  return rows
    .map((row) => ({
      ...row,
      total: Number(row.total ?? 0),
      human: Number(row.human ?? 0),
      ai_auto: Number(row.ai_auto ?? 0),
      automation: Number(row.automation ?? 0),
      com_sugestao: Number(row.com_sugestao ?? 0),
      aceitas: Number(row.aceitas ?? 0),
      trocadas: Number(row.trocadas ?? 0),
    }))
    .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, 'pt-BR'));
}

export function percentage(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

export function summarizeTabulacoes(rows: TabulacaoRow[]) {
  const totals = rows.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      semTabulacao:
        sum.semTabulacao + (row.codigo_tabulacao === 16 ? row.total : 0),
      comSugestao: sum.comSugestao + row.com_sugestao,
      aceitas: sum.aceitas + row.aceitas,
      trocadas: sum.trocadas + row.trocadas,
    }),
    { total: 0, semTabulacao: 0, comSugestao: 0, aceitas: 0, trocadas: 0 }
  );
  return {
    ...totals,
    semTabulacaoPct: percentage(totals.semTabulacao, totals.total),
    // Só decisões humanas entram no denominador; fechamento automático não é aceite.
    aceitasPct: percentage(totals.aceitas, totals.aceitas + totals.trocadas),
  };
}
