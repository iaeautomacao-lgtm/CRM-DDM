// Documentação pública da API (/docs/api) — sem login: descreve só o contrato (a mesma spec pública
// de /api/v1/openapi.json) e nenhum segredo. Exemplos gerados de src/lib/api/v1/openapi.ts.
import type { Metadata } from 'next';

import { ApiDocsPage } from '@/components/docs/api-docs-page';
import { buildGuideExamples } from '@/lib/api/v1/docs-guide';
import { buildReference } from '@/lib/api/v1/docs-reference';

export const metadata: Metadata = {
  title: 'Documentação da API',
  description: 'Guia e referência da API pública do CRM DDM: autenticação, grupos de rotas, exemplos, erros e limites.',
};

export default function ApiDocsRoute() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  return <ApiDocsPage examples={buildGuideExamples(appUrl)} reference={buildReference(appUrl)} />;
}
