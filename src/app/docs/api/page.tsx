// Documentação pública da API (/docs/api) — sem login: descreve só o contrato (a mesma spec pública
// de /api/v1/openapi.json) e nenhum segredo. Exemplos gerados de src/lib/api/v1/openapi.ts.
import type { Metadata } from 'next';

import { ApiDocsPage } from '@/components/docs/api-docs-page';
import { buildGuideExamples } from '@/lib/api/v1/docs-guide';

export const metadata: Metadata = {
  title: 'Documentação da API',
  description: 'Guia e referência da API pública do CRM DDM: campanhas, envio avulso e relatórios.',
};

export default function ApiDocsRoute() {
  return <ApiDocsPage examples={buildGuideExamples(process.env.NEXT_PUBLIC_APP_URL)} />;
}
