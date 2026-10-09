// Lista de agentes do redesenho: chips só com dados reais da versão publicada e filtros.
import { describe, expect, it } from 'vitest';

import { agentChips, filterAgents } from './agent-list';
import type { AgentListItem } from './types';

const base = (over: Partial<AgentListItem>): AgentListItem => ({
  id: 'a',
  name: 'Agente',
  enabled: true,
  published_version: { id: 'v', version: 2, created_at: '2026-10-09T10:00:00Z' },
  used_in_flows: 0,
  updated_at: '2026-10-09T10:00:00Z',
  summary: null,
  ...over,
});

describe('agentChips', () => {
  it('sem versão publicada: nenhum chip (nada inventado)', () => {
    expect(agentChips(base({ summary: null }))).toEqual([]);
  });

  it('modelo pelo rótulo do catálogo, modo, ferramentas, conhecimento e busca por trechos', () => {
    const chips = agentChips(
      base({
        summary: { provider: 'openai', model: 'gpt-4o-mini', mode: 'loop', tools: 1, knowledge: 'explicit', files: 3, vector: true },
      }),
    ).map((c) => c.text);
    expect(chips).toEqual(['GPT-4o mini', 'Conversa (loop)', '1 ferramenta', '3 arquivos', 'Busca por trechos']);
  });

  it('modelo fora do catálogo aparece pelo id; todos os arquivos da conta', () => {
    const chips = agentChips(
      base({ summary: { provider: 'openai', model: 'modelo-x', mode: 'once', tools: 0, knowledge: 'legacy_account_all', files: null, vector: false } }),
    ).map((c) => c.text);
    expect(chips).toEqual(['modelo-x', 'Uma resposta', '0 ferramentas', 'Todos os arquivos']);
  });
});

describe('filterAgents', () => {
  const list = [
    base({ id: '1', name: 'Cobrança', enabled: true }),
    base({ id: '2', name: 'Suporte', enabled: false }),
    base({ id: '3', name: 'Rascunho', enabled: true, published_version: null }),
  ];
  it('filtra por situação e busca pelo nome sem diferenciar maiúsculas', () => {
    expect(filterAgents(list, 'all', '').map((a) => a.id)).toEqual(['1', '2', '3']);
    expect(filterAgents(list, 'on', '').map((a) => a.id)).toEqual(['1', '3']);
    expect(filterAgents(list, 'off', '').map((a) => a.id)).toEqual(['2']);
    expect(filterAgents(list, 'draft', '').map((a) => a.id)).toEqual(['3']);
    expect(filterAgents(list, 'all', 'SUP').map((a) => a.id)).toEqual(['2']);
  });
});
