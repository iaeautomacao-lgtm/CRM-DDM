import { describe, expect, it } from 'vitest';
import { openApiSpec } from './openapi';
import { ERROR_ROWS, GUIDE_COVERAGE, GUIDE_SECTIONS, SCOPE_ROWS, buildGuideExamples } from './docs-guide';
import { API_KEY_PLACEHOLDER, requestFromOperation, toCurl, toN8n } from './docs-examples';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const operations = Object.entries(openApiSpec.paths as Record<string, Record<string, { operationId: string }>>).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({ path, method, operationId: item[method].operationId })),
);

describe('cobertura do guia amigável', () => {
  it('toda operação da spec tem seção no guia (e o guia não cita operação que não existe)', () => {
    const ids = new Set<string>(GUIDE_SECTIONS.map((s) => s.id));
    for (const op of operations) {
      expect(GUIDE_COVERAGE[op.operationId], `${op.method.toUpperCase()} ${op.path} (${op.operationId}) sem seção em docs-guide.ts`).toBeTruthy();
      expect(ids.has(GUIDE_COVERAGE[op.operationId])).toBe(true);
    }
    const known = new Set(operations.map((o) => o.operationId));
    for (const id of Object.keys(GUIDE_COVERAGE)) expect(known.has(id), `GUIDE_COVERAGE cita operação inexistente: ${id}`).toBe(true);
  });

  it('a tabela de erros cobre todo error.code da spec', () => {
    const codes = (openApiSpec.components.schemas.ErrorCode as { enum: readonly string[] }).enum;
    const documented = new Set(ERROR_ROWS.map((r) => r.code));
    for (const code of codes) expect(documented.has(code), `error.code ${code} sem linha na tabela de erros`).toBe(true);
  });

  it('a tabela de escopos cobre os escopos usados pelas rotas', () => {
    const text = SCOPE_ROWS.map((r) => r.scope).join(' ');
    for (const scope of ['campaigns:write', 'campaigns:read', 'messages:send', 'reports:read']) expect(text).toContain(scope);
  });
});

describe('exemplos gerados da spec', () => {
  it('toda operação gera curl e n8n sem placeholder de caminho pendente e sem chave real', () => {
    const base = 'https://crm.exemplo.com/api/v1';
    for (const op of operations) {
      const req = requestFromOperation(openApiSpec as never, op.path, op.method);
      expect(req.path).not.toMatch(/[{}]/);
      expect(req.headers.Authorization).toBe(`Bearer ${API_KEY_PLACEHOLDER}`);
      expect(toCurl(base, req)).toContain(base);
      expect(() => JSON.parse(toN8n(base, req))).not.toThrow();
    }
  });

  it('o exemplo de campanha Meta e WAHA vem dos exemplos da spec', () => {
    const ex = buildGuideExamples('https://crm.exemplo.com/');
    expect(ex.baseUrl).toBe('https://crm.exemplo.com/api/v1');
    expect(JSON.parse(ex.payloadMeta)).toMatchObject({ template_name: expect.any(String) });
    expect(JSON.parse(ex.payloadMeta)).not.toHaveProperty('message');
    expect(JSON.parse(ex.payloadWaha)).toMatchObject({ message: expect.stringContaining('{{1}}') });
    expect(ex.snippets.avulso.curl).toContain('Idempotency-Key');
    const n8n = JSON.parse(ex.snippets.campanhaMeta.n8n);
    expect(n8n.nodes[0].type).toBe('n8n-nodes-base.httpRequest');
    expect(n8n.nodes[0].parameters.method).toBe('POST');
  });

  it('aspas simples no corpo não quebram o curl', () => {
    const curl = toCurl('https://x/api/v1', { method: 'POST', path: '/a', headers: {}, query: {}, body: { t: "d'agua" } });
    expect(curl).toContain("d'\\''agua");
  });
});
