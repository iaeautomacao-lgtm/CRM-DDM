// Estrutura do guia amigável (/docs/api): seções, tabelas e a COBERTURA de cada operação da spec.
// Regra: toda operação nova em openapi.ts precisa aparecer em GUIDE_COVERAGE (o teste
// docs-guide.test.ts falha se faltar) — e a referência (Scalar) já a lista, pois lê o openapi.json.

import { openApiSpec } from './openapi';
import { apiBaseUrl, buildSnippets, requestFromOperation, type Snippets } from './docs-examples';

export const GUIDE_SECTIONS = [
  { id: 'comece', title: 'Comece aqui' },
  { id: 'campanha', title: 'Disparar campanha (Meta × WAHA)' },
  { id: 'acompanhar', title: 'Acompanhar a campanha' },
  { id: 'avulso', title: 'Envio avulso' },
  { id: 'relatorios', title: 'Relatórios para BI' },
  { id: 'webhooks', title: 'Webhooks de saída' },
  { id: 'erros', title: 'Erros e limites' },
] as const;

export type GuideSectionId = (typeof GUIDE_SECTIONS)[number]['id'];

/** operationId → seção do guia que o explica. */
export const GUIDE_COVERAGE: Record<string, GuideSectionId> = {
  getMe: 'comece',
  createCampaign: 'campanha',
  getCampaign: 'acompanhar',
  sendWhatsappMessage: 'avulso',
  getReportOperationsCurrent: 'relatorios',
  getReportOperationsSummary: 'relatorios',
  getReportTeams: 'relatorios',
  getReportAgents: 'relatorios',
  getReportTabulations: 'relatorios',
  listWebhooks: 'webhooks',
  createWebhook: 'webhooks',
  getWebhook: 'webhooks',
  updateWebhook: 'webhooks',
  deleteWebhook: 'webhooks',
  listWebhookDeliveries: 'webhooks',
  replayWebhookDelivery: 'webhooks',
  rotateWebhookSecret: 'webhooks',
  testWebhook: 'webhooks',
};

export interface ScopeRow {
  scope: string;
  paraQue: string;
  endpoints: string;
}

export const SCOPE_ROWS: ScopeRow[] = [
  { scope: 'campaigns:write', paraQue: 'Disparar campanha (e também consultar campanhas)', endpoints: 'POST /disparador/campaigns' },
  { scope: 'campaigns:read', paraQue: 'Só acompanhar campanhas', endpoints: 'GET /disparador/campaigns/{id}' },
  { scope: 'messages:send', paraQue: 'Enviar mensagem avulsa', endpoints: 'POST /whatsapp/send' },
  { scope: 'reports:read', paraQue: 'Relatórios para Power BI, Metabase, n8n', endpoints: 'GET /reports/*' },
  { scope: 'webhooks:write', paraQue: 'Cadastrar/alterar webhooks de saída e reenviar entregas (também lê)', endpoints: 'POST/PATCH/DELETE /webhooks…' },
  { scope: 'webhooks:read', paraQue: 'Só consultar webhooks e o histórico de entregas', endpoints: 'GET /webhooks…' },
  { scope: '(nenhum)', paraQue: 'Testar se a chave funciona', endpoints: 'GET /me' },
];

export interface ErrorRow {
  http: string;
  code: string;
  significa: string;
  fazer: string;
}

/** Tabela de erros em português. O teste garante que todo `error.code` da spec tem linha aqui. */
export const ERROR_ROWS: ErrorRow[] = [
  { http: '400', code: 'bad_request', significa: 'Algo no pedido está errado (campo faltando, telefone inválido, template não aprovado, nenhum contato válido…).', fazer: 'Leia `error.message` (e `invalid_sample`, quando vier), corrija e envie de novo. No envio avulso, a Idempotency-Key NÃO é consumida.' },
  { http: '401', code: 'unauthorized', significa: 'Chave ausente, errada, revogada ou expirada.', fazer: 'Confira o header `Authorization: Bearer …` e se a chave ainda existe em Configurações → Chaves de API.' },
  { http: '403', code: 'forbidden', significa: 'A chave não tem o escopo necessário.', fazer: 'Peça a um admin uma chave com o escopo da tabela de escopos.' },
  { http: '404', code: 'not_found', significa: 'Recurso não existe (ou é de outra conta).', fazer: 'Confira o id. Campanha de outra conta também devolve 404.' },
  { http: '409', code: 'conflict', significa: 'A Idempotency-Key / external_id já foi usada com outro conteúdo, ou o envio anterior está em andamento / com resultado desconhecido.', fazer: 'Não mude a chave para "forçar". Reenvie exatamente o mesmo corpo; se vier `provider_outcome_unknown`, aguarde e NÃO reenvie.' },
  { http: '413', code: 'payload_too_large', significa: 'Mais de 20.000 contatos ou corpo acima de 15 MB.', fazer: 'Divida em várias campanhas.' },
  { http: '422', code: 'recipient_blocked', significa: 'O destinatário está na blacklist / pediu opt-out.', fazer: 'Não tente de novo: o número não pode receber mensagens.' },
  { http: '429', code: 'rate_limited', significa: 'Mais de 120 requisições por minuto com a mesma chave — ou, em `POST /disparador/campaigns`, mais de 6 criações de campanha por minuto.', fazer: 'Espere `Retry-After` segundos e tente de novo; reduza o ritmo.' },
  { http: '500 / 502', code: 'internal', significa: 'Falha nossa ou do provedor (Meta/WAHA).', fazer: 'Se vier `campaign_id` num 500 de campanha, a criação foi desfeita e repetir é seguro. No envio avulso, repita com a MESMA Idempotency-Key.' },
  { http: '503', code: 'unavailable', significa: 'Serviço temporariamente indisponível.', fazer: 'Tente de novo em instantes, com a mesma Idempotency-Key.' },
];

export type ExampleKey = 'me' | 'campanhaMeta' | 'campanhaWaha' | 'acompanhar' | 'avulso' | 'relatorio';

export interface GuideExamples {
  snippets: Record<ExampleKey, Snippets>;
  /** Corpo JSON (bonito) dos dois exemplos de campanha, para as colunas Meta × WAHA. */
  payloadMeta: string;
  payloadWaha: string;
  baseUrl: string;
}

/** Exemplos do guia, gerados da spec (servidor). */
export function buildGuideExamples(appUrl: string | undefined): GuideExamples {
  const baseUrl = apiBaseUrl(appUrl);
  const spec = openApiSpec as unknown as Record<string, unknown>;
  const req = (path: string, method: 'get' | 'post', example?: string) => requestFromOperation(spec, path, method, example);
  const make = (path: string, method: 'get' | 'post', example: string | undefined, name: string) =>
    buildSnippets(baseUrl, req(path, method, example), name);
  return {
    baseUrl,
    snippets: {
      me: make('/me', 'get', undefined, 'Quem sou eu?'),
      campanhaMeta: make('/disparador/campaigns', 'post', 'meta_template', 'Disparar campanha (Meta)'),
      campanhaWaha: make('/disparador/campaigns', 'post', 'waha_texto', 'Disparar campanha (WAHA)'),
      acompanhar: make('/disparador/campaigns/{id}', 'get', undefined, 'Acompanhar campanha'),
      avulso: make('/whatsapp/send', 'post', 'texto', 'Enviar mensagem avulsa'),
      relatorio: make('/reports/operations/summary', 'get', undefined, 'Relatório de operação'),
    },
    payloadMeta: JSON.stringify(req('/disparador/campaigns', 'post', 'meta_template').body, null, 2),
    payloadWaha: JSON.stringify(req('/disparador/campaigns', 'post', 'waha_texto').body, null, 2),
  };
}
