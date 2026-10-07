import { describe, expect, it } from 'vitest';
import {
  normalizeTabulacoes,
  percentage,
  summarizeTabulacoes,
  type RawTabulacaoRow,
} from './tabulacoes';

const row = (values: Partial<RawTabulacaoRow>): RawTabulacaoRow => ({
  codigo_tabulacao: 142,
  nome: 'Acordo',
  total: '10',
  human: '3',
  ai_auto: '5',
  automation: '2',
  com_sugestao: '8',
  aceitas: '2',
  trocadas: '1',
  ...values,
});

describe('relatório de tabulações', () => {
  it('normaliza bigint e ordena por total, com desempate por nome', () => {
    const rows = normalizeTabulacoes([
      row({ nome: 'Z', total: '2' }),
      row({ nome: 'A', total: '2' }),
      row({}),
    ]);
    expect(rows.map((r) => r.nome)).toEqual(['Acordo', 'A', 'Z']);
    expect(rows[0].total).toBe(10);
    expect(rows[0].aceitas).toBe(2);
  });
  it('soma grupos e usa decisões humanas, sem incluir automáticos no aceite', () => {
    const summary = summarizeTabulacoes(
      normalizeTabulacoes([
        row({}),
        row({ codigo_tabulacao: 16, total: '10', aceitas: '1', trocadas: '2' }),
      ])
    );
    expect(summary).toMatchObject({
      total: 20,
      semTabulacao: 10,
      semTabulacaoPct: 50,
      comSugestao: 16,
      aceitas: 3,
      trocadas: 3,
      aceitasPct: 50,
    });
  });
  it('não trata tag personalizada sem código como sem tabulação', () => {
    expect(
      summarizeTabulacoes(
        normalizeTabulacoes([row({ codigo_tabulacao: null })])
      ).semTabulacao
    ).toBe(0);
  });
  it('período vazio ou sem decisão humana não divide por zero', () => {
    expect(summarizeTabulacoes([])).toMatchObject({
      total: 0,
      semTabulacaoPct: 0,
      aceitasPct: 0,
    });
    expect(percentage(0, 0)).toBe(0);
    expect(
      summarizeTabulacoes(
        normalizeTabulacoes([row({ aceitas: 0, trocadas: 0 })])
      ).aceitasPct
    ).toBe(0);
  });
});
