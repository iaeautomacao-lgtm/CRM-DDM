import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ mode: 'light', toggleMode: () => {} }) }));

import { openApiSpec } from '@/lib/api/v1/openapi';
import { buildGuideExamples } from '@/lib/api/v1/docs-guide';
import { buildReference } from '@/lib/api/v1/docs-reference';
import { ApiDocsPage } from './api-docs-page';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const APP = 'https://crm.exemplo.com';

describe('/docs/api — renderiza sem sessão', () => {
  const html = renderToString(createElement(ApiDocsPage, { examples: buildGuideExamples(APP), reference: buildReference(APP) }));
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

  it('mostra a marca, a busca, "Comece aqui" e "Erros e limites"', () => {
    expect(text).toContain('Documentação da API');
    expect(html).toContain('aria-label="Buscar na documentação"');
    expect(text).toContain('Comece aqui');
    expect(text).toContain('Erros e limites');
    expect(text).toContain('https://crm.exemplo.com/api/v1');
  });

  it('explica a autenticação: onde criar a chave, o formato e os escopos', () => {
    expect(text).toContain('Integrações → Chaves de API');
    expect(text).toContain('Authorization: Bearer SUA_CHAVE_DE_API');
    expect(text).toContain('wacrm_live_');
    expect(text).toContain('campaigns:write');
  });

  it('todo grupo e toda rota da spec têm âncora na página (falha se surgir rota sem bloco)', () => {
    for (const tag of openApiSpec.tags) expect(text).toContain(tag.name);
    for (const item of Object.values(openApiSpec.paths as Record<string, Record<string, { operationId?: string }>>)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        expect(html.includes(`id="${op.operationId}"`), `sem bloco/âncora para ${op.operationId}`).toBe(true);
      }
    }
  });

  it('cada rota mostra método, caminho e o exemplo de requisição', () => {
    expect(text).toContain('/disparador/campaigns');
    expect(html).toContain('role="tablist"');
    expect(text).toContain('Python');
    expect(text).toContain('Respostas e erros');
  });

  it('Meta × WAHA lado a lado e as dicas de idempotência/24h', () => {
    expect(text).toContain('template_name');
    expect(text).toContain('{{1}}');
    expect(text).toContain('Idempotency-Key');
    expect(text).toContain('24 horas');
    expect(text).toContain('120 por minuto');
  });

  it('não vaza segredo: só o marcador da chave', () => {
    expect(html).not.toMatch(/wacrm_live_[A-Za-z0-9]{8,}/);
    expect(html).not.toMatch(/whsec_[A-Za-z0-9]{8,}/);
    expect(text).toContain('SUA_CHAVE_DE_API');
  });
});

describe('Configurações → Documentação da API', () => {
  it('item próprio no menu, visível só para supervisor ou acima', async () => {
    const { canSeeSection, SECTION_META } = await import('@/components/settings/settings-sections');
    expect(SECTION_META['api-docs'].label).toBe('Documentação da API');
    expect(canSeeSection('api-docs', 'supervisor')).toBe(true);
    expect(canSeeSection('api-docs', 'admin')).toBe(true);
    expect(canSeeSection('api-docs', 'agent')).toBe(false);
    expect(canSeeSection('api-docs', 'viewer')).toBe(false);
    expect(canSeeSection('api-docs', null)).toBe(false);
  });
});
