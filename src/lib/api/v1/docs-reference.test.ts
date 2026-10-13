import { describe, expect, it } from 'vitest';

import { openApiSpec } from './openapi';
import { OPERATION_SCOPES, buildReference } from './docs-reference';
import { toPython } from './docs-examples';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const specOperations = Object.entries(openApiSpec.paths as Record<string, Record<string, { operationId: string }>>).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({ path, method: method.toUpperCase(), id: item[method].operationId })),
);

describe('referência montada da spec', () => {
  const ref = buildReference('https://crm.exemplo.com/');
  const ops = ref.groups.flatMap((g) => g.operations);

  it('inclui toda operação da spec, uma vez, e nenhuma a mais', () => {
    expect(ops.map((o) => o.id).sort()).toEqual(specOperations.map((o) => o.id).sort());
    for (const s of specOperations) {
      const op = ops.find((o) => o.id === s.id);
      expect(op?.method).toBe(s.method);
      expect(op?.path).toBe(s.path);
    }
  });

  it('agrupa pelas tags da spec, com âncora estável e sem grupo vazio', () => {
    expect(ref.groups.map((g) => g.name)).toEqual(['Conta', 'Mensagens', 'Disparador', 'Relatórios', 'Webhooks', 'Extração']);
    expect(ref.groups.map((g) => g.id)).toContain('grupo-extracao');
    for (const g of ref.groups) expect(g.operations.length).toBeGreaterThan(0);
  });

  it('todo operationId tem escopo mapeado e o mapa não cita operação inexistente', () => {
    for (const s of specOperations) expect(OPERATION_SCOPES[s.id], `${s.id} sem escopo em OPERATION_SCOPES`).toBeDefined();
    const known = new Set(specOperations.map((s) => s.id));
    for (const id of Object.keys(OPERATION_SCOPES)) expect(known.has(id), id).toBe(true);
  });

  it('as campanhas trazem os dois exemplos de corpo (Meta e WAHA) e campos do corpo', () => {
    const create = ops.find((o) => o.id === 'createCampaign')!;
    expect(create.snippetSets).toHaveLength(2);
    expect(create.body?.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['campaign_name', 'contacts', 'contacts[].phone']));
    expect(create.body?.fields.find((f) => f.name === 'campaign_name')?.required).toBe(true);
  });

  it('parâmetros de caminho são obrigatórios e a query traz o que a spec descreve', () => {
    const messages = ops.find((o) => o.id === 'listConversationMessages')!;
    expect(messages.params.find((p) => p.name === 'id')).toMatchObject({ in: 'path', required: true });
    expect(messages.params.some((p) => p.in === 'query' && p.name === 'cursor')).toBe(true);
  });

  it('respostas resolvem $ref de erro e o sucesso traz exemplo', () => {
    const me = ops.find((o) => o.id === 'getMe')!;
    expect(me.responses.map((r) => r.status)).toEqual(['200', '401', '429', '500']);
    expect(me.responses.every((r) => r.description.length > 0)).toBe(true);
    expect(me.responses[0].examples[0].json).toContain('"data"');
  });

  it('snippets de toda rota: curl, JS, Python e n8n, só com o marcador da chave', () => {
    for (const op of ops) {
      for (const set of op.snippetSets) {
        for (const code of [set.snippets.curl, set.snippets.js, set.snippets.python, set.snippets.n8n]) {
          expect(code).toContain('SUA_CHAVE_DE_API');
          expect(code).not.toMatch(/wacrm_live_[A-Za-z0-9]{8,}/);
        }
        expect(set.snippets.python).toContain('import requests');
        expect(() => JSON.parse(set.snippets.n8n)).not.toThrow();
      }
    }
  });
});

describe('toPython', () => {
  it('gera literais Python (True/False/None) e params', () => {
    const code = toPython('https://x.test/api/v1', {
      method: 'POST',
      path: '/a',
      headers: { Authorization: 'Bearer K' },
      query: { q: '1' },
      body: { ok: true, off: false, vazio: null, lista: [1, 'a'] },
    });
    expect(code).toContain('requests.post(');
    expect(code).toContain('"ok": True');
    expect(code).toContain('"off": False');
    expect(code).toContain('"vazio": None');
    expect(code).toContain('params={');
    expect(code).not.toContain('true');
  });
});
