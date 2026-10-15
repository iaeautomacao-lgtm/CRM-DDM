// OpenAPI da LEITURA de campanhas (Onda 1, bloco A1): lista, detalhe enriquecido e status por destinatário.
// Mesclado em openapi.ts (get da lista, propriedades do detalhe, rota de recipients, schemas e guia), no padrão de
// openapi-extract.ts e openapi-webhooks.ts. Sem segredo: só contrato. Desenho: prd-v2/api-onda1-desenho.md.
import { CAMPAIGN_STATUSES, RECIPIENT_STATUSES } from './campaign-api';

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const errorExample = (code: string, message: string): Json => ({ error: { code, message } });
const apiError = (description: string, code: string, message: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: errorExample(code, message) } },
});
const common = { '401': resp('Unauthorized'), '403': resp('Forbidden'), '429': resp('RateLimited'), '500': resp('InternalError') };

export const CAMPAIGN_READ_GUIDE = [
  '',
  '## Campanhas: leitura e conciliação',
  'Para o ERP acompanhar o que foi disparado. Escopo `campaigns:read` (ou `campaigns:write`). Sempre da conta da chave; campanha de outra conta devolve `404`.',
  '',
  '- `GET /disparador/campaigns` lista as campanhas (mais recentes primeiro) com métricas agregadas. Filtros: `status` (vários, separados por vírgula), `source` (`api_v1` ou `dashboard`), `external_id` (o `Idempotency-Key`/`external_id` usado na criação), `created_from`, `created_to`. Paginação por `cursor` opaco (`next_cursor` nulo = fim).',
  '- `GET /disparador/campaigns/{id}` traz status, janela, métricas e fila, mais canal, template, motivo da pausa e, quando a conta usa o rastreio de links (UTMpay), o funil `clicked`/`closed`/`paid` com atribuição `direct`/`ai`/`human`. Os campos que já existiam não mudaram; os novos são aditivos.',
  '- `GET /disparador/campaigns/{id}/recipients` devolve o **estado atual de cada destinatário** (`queued`, `paused`, `sending`, `sent`, `delivered`, `read`, `error`, `blocked`, `cancelled`), com `replied_at`, erro classificado e, havendo link rastreado, `funnel`. Filtros: `status`, `replied`, `clicked`, `closed`, `paid`, `phone`. É extração de dado pessoal (telefone e nome): **60 requisições por minuto por chave** e cada chamada é auditada (só a quantidade, nunca o conteúdo). O CPF nunca sai.',
  '',
  '**Status é o estado atual, não cumulativo:** um destinatário que foi entregue e lido aparece só como `read`. Para o total de entregues some `delivered` e `read` (ou use `metrics.delivered` da campanha). O horário de entrega/leitura por destinatário não é guardado; só `sent_at` e `replied_at`.',
].join('\n');

const cursorParam = { name: 'cursor', in: 'query', required: false, description: 'Cursor opaco devolvido em `next_cursor` da página anterior.', schema: { type: 'string' } };
const isoParam = (name: string, description: string) => ({ name, in: 'query', required: false, description, schema: { type: 'string', format: 'date-time' } });
const boolParam = (name: string, description: string) => ({ name, in: 'query', required: false, description, schema: { type: 'boolean' } });

const listExample = {
  data: {
    items: [
      {
        campaign_id: '7c9e6679-0000-4000-8000-000000000020',
        name: 'Cobrança outubro — lote 3',
        status: 'em_execucao',
        source: 'api_v1',
        external_id: 'planejamento-2026-10-lote-3',
        created_at: '2026-10-07T13:17:05.616Z',
        window: { start: '08:00:00', end: '18:00:00' },
        provider: 'meta',
        message_type: 'template',
        metrics: { total_contacts: 1000, sent: 450, delivered: 440, read: 200, errors: 10, pending: 550 },
        paused_reason: null,
      },
    ],
    next_cursor: null,
  },
};

export const campaignListGet = {
  tags: ['Disparador'],
  operationId: 'listCampaigns',
  summary: 'Listar campanhas',
  description:
    'Exige `campaigns:read` **ou** `campaigns:write`. Mais recentes primeiro; sem dado pessoal de cliente (só métricas agregadas). `status` aceita vários valores separados por vírgula.',
  parameters: [
    { name: 'status', in: 'query', required: false, description: `Um ou mais de: ${CAMPAIGN_STATUSES.join(', ')} (vírgula).`, schema: { type: 'string' } },
    { name: 'source', in: 'query', required: false, description: 'Origem da campanha.', schema: { type: 'string', enum: ['api_v1', 'dashboard'] } },
    { name: 'external_id', in: 'query', required: false, description: '`Idempotency-Key` ou `external_id` usado na criação pela API.', schema: { type: 'string', maxLength: 128 } },
    isoParam('created_from', 'Criada a partir de (inclusivo, ISO 8601).'),
    isoParam('created_to', 'Criada antes de (exclusivo, ISO 8601).'),
    { name: 'limit', in: 'query', required: false, description: 'Itens por página (1 a 200).', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    cursorParam,
  ],
  responses: {
    '200': {
      description: 'Página de campanhas.',
      content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: ref('CampaignList') } }, example: listExample } },
    },
    '400': apiError('Filtro ou cursor inválido.', 'bad_request', "'status' inválido: ativa"),
    ...common,
  },
};

const recipientExample = {
  data: {
    items: [
      {
        recipient_id: '2d5c8e40-0000-4000-8000-000000000301',
        phone: '5521999998888',
        contact_id: null,
        name: null,
        status: 'delivered',
        status_raw: 'entregue',
        scheduled_at: '2026-10-07T13:20:00.000Z',
        sent_at: '2026-10-07T13:20:04.000Z',
        replied_at: null,
        error: null,
        conversation_id: null,
        funnel: { clicked: true, closed: false, paid: false, clicked_at: '2026-10-07T13:41:00.000Z', closed_at: null, paid_at: null, attribution: null, attendant_id: null },
      },
    ],
    next_cursor: 'WyIyMDI2LTEwLTA3VDEzOjIwOjAwLjAwMFoiLCIyZDVjOGU0MC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAzMDEiXQ',
  },
};

export const campaignPaths: Record<string, Json> = {
  '/disparador/campaigns/{id}/recipients': {
    get: {
      tags: ['Disparador'],
      operationId: 'listCampaignRecipients',
      summary: 'Status por destinatário da campanha',
      description: [
        'Exige `campaigns:read` **ou** `campaigns:write`. Extração de dado pessoal: **60 requisições por minuto por chave**, auditada (quantidade, nunca o conteúdo). Campanha de outra conta devolve `404`.',
        '',
        'Ordem estável por horário agendado e id; paginação por `cursor` opaco. Com `clicked`, `closed` ou `paid` a consulta passa a listar só quem tem link rastreado (UTMpay) e usa outra ordem de cursor: **não troque os filtros no meio da paginação** (o cursor de uma consulta é recusado em outra).',
        '',
        '`status` é o estado **atual**; `status_raw` é o valor interno da fila. Campanha criada pela API tem contato externo: `contact_id` e `name` nulos, `phone` preenchido.',
      ].join('\n'),
      parameters: [
        { name: 'id', in: 'path', required: true, description: 'ID da campanha (`campaign_id`).', schema: { type: 'string', format: 'uuid' } },
        { name: 'status', in: 'query', required: false, description: `Um ou mais de: ${RECIPIENT_STATUSES.join(', ')} (vírgula).`, schema: { type: 'string' } },
        boolParam('replied', 'Só quem respondeu à campanha.'),
        boolParam('clicked', 'Só quem clicou no link rastreado (exige o rastreio UTMpay).'),
        boolParam('closed', 'Só quem fechou o acordo (exige o rastreio UTMpay).'),
        boolParam('paid', 'Só quem pagou (exige o rastreio UTMpay).'),
        { name: 'phone', in: 'query', required: false, description: 'Telefone (DDI + DDD + número); tolera o 9º dígito.', schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, description: 'Itens por página (1 a 500).', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        cursorParam,
      ],
      responses: {
        '200': {
          description: 'Página de destinatários.',
          content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: ref('RecipientList') } }, example: recipientExample } },
        },
        '400': apiError('Filtro ou cursor inválido, ou rastreio indisponível.', 'bad_request', "'status' inválido: ok"),
        '404': apiError('Campanha inexistente ou de outra conta.', 'not_found', 'Campanha não encontrada'),
        ...common,
      },
    },
  },
};

const metricsSchema = {
  type: 'object',
  properties: {
    total_contacts: { type: 'integer' },
    sent: { type: 'integer' },
    delivered: { type: 'integer' },
    read: { type: 'integer' },
    errors: { type: 'integer' },
    pending: { type: 'integer', description: 'Itens ainda agendados na fila.' },
  },
};

const attribution = { type: 'object', properties: { direct: { type: 'integer' }, ai: { type: 'integer' }, human: { type: 'integer' } } };

/** Campos novos do detalhe (GET /disparador/campaigns/{id}); aditivos sobre o schema `Campaign`. */
export const campaignDetailProperties = {
  source: { type: 'string', enum: ['api_v1', 'dashboard'] },
  external_id: { type: ['string', 'null'], description: '`Idempotency-Key`/`external_id` usado na criação pela API.' },
  provider: { type: ['string', 'null'], enum: ['meta', 'waha', null] },
  message_type: { type: ['string', 'null'], enum: ['text', 'image', 'template', null] },
  channel: {
    type: ['object', 'null'],
    properties: { id: { type: 'string', format: 'uuid' }, label: { type: 'string' }, waha_session: { type: 'string', description: 'Só em canal WAHA.' } },
  },
  template: { type: ['object', 'null'], properties: { name: { type: 'string' }, language: { type: ['string', 'null'] } } },
  started_at: { type: ['string', 'null'], format: 'date-time' },
  callback_configured: { type: 'boolean', description: 'Há `callback_url`; a URL não é devolvida.' },
  pause: {
    type: ['object', 'null'],
    description: 'Só com a campanha pausada.',
    properties: {
      automatic: { type: 'boolean', description: 'Pausada pelo motor (taxa de erro, template etc.).' },
      reason: { type: ['string', 'null'] },
      template: { type: ['object', 'null'], properties: { name: { type: 'string' }, language: { type: ['string', 'null'] } } },
    },
  },
  replied: { type: 'integer', description: 'Destinatários que responderam.' },
  funnel: {
    type: ['object', 'null'],
    description: 'Rastreio de links (UTMpay); nulo quando a conta não usa ou não está disponível.',
    properties: {
      links: { type: 'integer' },
      clicked: { type: 'integer' },
      closed: { type: 'integer' },
      paid: { type: 'integer' },
      rates: { type: 'object', properties: { clicked: { type: ['number', 'null'] }, closed: { type: ['number', 'null'] }, paid: { type: ['number', 'null'] } } },
      by_attribution: { type: 'object', properties: { closed: attribution, paid: attribution } },
    },
  },
};

export const campaignSchemas: Record<string, Json> = {
  CampaignListItem: {
    type: 'object',
    properties: {
      campaign_id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      status: { type: 'string', enum: [...CAMPAIGN_STATUSES] },
      source: { type: 'string', enum: ['api_v1', 'dashboard'] },
      external_id: { type: ['string', 'null'] },
      created_at: { type: 'string', format: 'date-time' },
      window: { type: 'object', properties: { start: { type: ['string', 'null'] }, end: { type: ['string', 'null'] } } },
      provider: { type: ['string', 'null'], enum: ['meta', 'waha', null] },
      message_type: { type: ['string', 'null'], enum: ['text', 'image', 'template', null] },
      metrics: metricsSchema,
      paused_reason: { type: ['string', 'null'], description: 'Motivo da pausa automática, quando pausada pelo motor.' },
    },
  },
  CampaignList: {
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items: ref('CampaignListItem') }, next_cursor: { type: ['string', 'null'] } },
  },
  Recipient: {
    type: 'object',
    properties: {
      recipient_id: { type: 'string', description: 'Id do item da fila.' },
      phone: { type: ['string', 'null'] },
      contact_id: { type: ['string', 'null'], format: 'uuid', description: 'Nulo em campanha criada pela API (contato externo).' },
      name: { type: ['string', 'null'] },
      status: { type: 'string', enum: [...RECIPIENT_STATUSES], description: 'Estado atual (não cumulativo).' },
      status_raw: { type: 'string', description: 'Valor interno da fila (`agendado`, `entregue`…).' },
      scheduled_at: { type: ['string', 'null'], format: 'date-time' },
      sent_at: { type: ['string', 'null'], format: 'date-time' },
      replied_at: { type: ['string', 'null'], format: 'date-time' },
      error: { type: ['object', 'null'], properties: { code: { type: ['integer', 'null'], description: 'Código de erro da Meta, quando houver.' }, type: { type: 'string' } } },
      conversation_id: { type: ['string', 'null'], format: 'uuid' },
      funnel: {
        type: ['object', 'null'],
        description: 'Só com link rastreado (UTMpay).',
        properties: {
          clicked: { type: 'boolean' },
          closed: { type: 'boolean' },
          paid: { type: 'boolean' },
          clicked_at: { type: ['string', 'null'], format: 'date-time' },
          closed_at: { type: ['string', 'null'], format: 'date-time' },
          paid_at: { type: ['string', 'null'], format: 'date-time' },
          attribution: { type: ['string', 'null'], enum: ['direct', 'ai', 'human', null] },
          attendant_id: { type: ['string', 'null'], format: 'uuid' },
        },
      },
    },
  },
  RecipientList: {
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items: ref('Recipient') }, next_cursor: { type: ['string', 'null'] } },
  },
};
