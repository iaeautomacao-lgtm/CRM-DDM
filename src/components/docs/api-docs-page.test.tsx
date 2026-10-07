import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ mode: 'light', toggleMode: () => {} }) }));

import { openApiSpec } from '@/lib/api/v1/openapi';
import { buildGuideExamples } from '@/lib/api/v1/docs-guide';
import { SCALAR_SRC, SCALAR_VERSION } from './api-reference';
import { ApiDocsPage } from './api-docs-page';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

describe('/docs/api — renderiza sem sessão', () => {
  const html = renderToString(createElement(ApiDocsPage, { examples: buildGuideExamples('https://crm.exemplo.com') }));
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

  it('mostra a marca, as duas abas e todas as seções do guia', () => {
    expect(text).toContain('Documentação da API');
    expect(text).toContain('Guia');
    expect(text).toContain('Referência');
    for (const title of ['Comece aqui', 'Disparar campanha', 'Acompanhar a campanha', 'Envio avulso', 'Relatórios para BI', 'Erros e limites']) {
      expect(text).toContain(title);
    }
    expect(text).toContain('https://crm.exemplo.com/api/v1');
  });

  it('o guia cita toda rota da spec (falha se surgir rota v1 sem guia)', () => {
    for (const [path, item] of Object.entries(openApiSpec.paths as Record<string, Record<string, unknown>>)) {
      for (const method of METHODS) {
        if (!item[method]) continue;
        const literal = `${method.toUpperCase()} ${path}`;
        expect(text.includes(literal), `o guia não menciona "${literal}"`).toBe(true);
      }
    }
  });

  it('Meta × WAHA lado a lado e as dicas de idempotência/24h', () => {
    expect(text).toContain('template_name');
    expect(text).toContain('{{1}}');
    expect(text).toContain('Idempotency-Key');
    expect(text).toContain('24 horas');
    expect(text).toContain('120 por minuto');
  });
});

describe('referência (Scalar) e CSP', () => {
  const config = readFileSync('next.config.ts', 'utf8');
  it('versão fixada, só o caminho do Scalar liberado e Swagger removido', () => {
    expect(SCALAR_SRC).toContain(`@scalar/api-reference@${SCALAR_VERSION}/`);
    expect(config).toContain(`https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/`);
    expect(config.toLowerCase()).not.toContain('swagger');
    expect(config).not.toMatch(/cdn\.jsdelivr\.net\/(?!npm\/@scalar\/api-reference@)/);
  });
  it('sem fontes externas, sem telemetria e sem envio de requisições reais', () => {
    const src = readFileSync('src/components/docs/api-reference.tsx', 'utf8');
    expect(src).toContain('withDefaultFonts: false');
    expect(src).toContain('hideTestRequestButton: true');
    expect(src).toContain('telemetry: false');
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
