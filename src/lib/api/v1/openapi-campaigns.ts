// OpenAPI da LEITURA de campanhas (Onda 1, bloco A1): lista, detalhe enriquecido e status por destinatário.
// Mesclado em openapi.ts (get da lista, propriedades do detalhe, rota de recipients, schemas e guia), no padrão de
// openapi-extract.ts e openapi-webhooks.ts. Sem segredo: só contrato. Desenho: prd-v2/api-onda1-desenho.md.
import { CAMPAIGN_STATUSES, RECIPIENT_STATUSES, REMOVE_ENTRY_STATUSES, REMOVE_MAX_RECIPIENTS, REMOVE_REASONS } from './campaign-api-constants';

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const errorExample = (code: string, message: string): Json => ({ error: { code, message } });
const apiError = (description: string, code: string, message: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: errorExample(code, message) } },
});
const common = { '401': resp('Unauthorized'), '403': resp('Forbidden'), '429': resp('RateLimited'), '500': resp('InternalError') };

export const CAMPAIGN_CONTROL_GUIDE = [
  '',
  '## Campanhas: controlar o envio',
  'Escopo `campaigns:write`. **30 requisições por minuto por chave** nestas rotas (além dos 120/min gerais). Todas são **idempotentes por estado**: repetir devolve `200` com `changed: false`, nunca um erro. Estado que não permite a ação devolve `409 conflict` com o estado atual em `error.details.status`.',
  '',
  '- `POST /disparador/campaigns/{id}/pause` pausa uma campanha em execução (corpo opcional `{ "reason": "…" }`, até 200 caracteres, visível no painel). Itens que já estão sendo enviados não são tocados.',
  '- `POST /disparador/campaigns/{id}/resume` retoma uma pausada. Se o **motor** pausou (taxa de erro etc.), envie `{ "acknowledge_auto_pause": true }` depois de corrigir a causa. Bloqueia **sempre** (409): template da campanha sem aprovação na Meta (`details.code = template_not_approved`) e número em qualidade vermelha (`details.code = red_quality`, a confirmação é do proprietário na tela).',
  '- `POST /disparador/campaigns/{id}/cancel` encerra a campanha. **Irreversível**: exige `{ "confirm": true }`; os itens agendados e pausados viram `cancelado`. Só cancela campanha em execução, pausada ou agendada.',
  '- `POST /disparador/campaigns/{id}/recipients/remove` tira destinatários **ainda não enviados** (ex.: o cliente pagou), por `phone`, `cpf` ou `reference`. Não é opt-out: a lista de bloqueio não é tocada. Quem já recebeu não se desfaz (`already_sent`); quem está sendo enviado agora volta como `in_flight` (repita depois). O CPF só acha quem já existe como contato no CRM e nunca é devolvido; para campanhas criadas pela API, o jeito mais seguro é mandar um `reference` por contato no `POST /disparador/campaigns` e usá-lo aqui.',
  '',
  'No detalhe da campanha, `ended_reason` diz se a encerrada foi `completed`, `cancelled` (tela) ou `cancelled_api`; `pause.reason` traz o motivo da pausa.',
].join('\n');

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

const idParam = { name: 'id', in: 'path', required: true, description: 'ID da campanha (`campaign_id`).', schema: { type: 'string', format: 'uuid' } };
const notFound = apiError('Campanha inexistente ou de outra conta.', 'not_found', 'Campanha não encontrada');
const stateConflict = (message: string, details: Json) => ({
  description: 'Estado da campanha não permite a ação, ou a ação está bloqueada (veja `error.details`).',
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: { error: { code: 'conflict', message, details } } } },
});
const controlOk = (description: string, example: Json) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: ref('CampaignControlResult') } }, example: { data: example } } },
});
const jsonBody = (schemaName: string, example: Json, required = false) => ({
  required,
  content: { 'application/json': { schema: ref(schemaName), example } },
});

export const campaignControlPaths: Record<string, Json> = {
  '/disparador/campaigns/{id}/pause': {
    post: {
      tags: ['Disparador'],
      operationId: 'pauseCampaign',
      summary: 'Pausar campanha',
      description: 'Exige `campaigns:write`. Pausa uma campanha **em execução**; itens já em envio não são tocados. Idempotente: já pausada devolve `200` com `changed: false`. 30 req/min por chave.',
      parameters: [idParam],
      requestBody: jsonBody('PauseCampaignRequest', { reason: 'Aguardando conferência da carteira' }),
      responses: {
        '200': controlOk('Campanha pausada (ou já estava).', { campaign_id: '7c9e6679-0000-4000-8000-000000000020', status: 'pausada', previous_status: 'em_execucao', changed: true, items_pending_move: false }),
        '400': apiError('Corpo inválido.', 'bad_request', "'reason' deve ser um texto de até 200 caracteres"),
        '404': notFound,
        '409': stateConflict('Só é possível pausar uma campanha em execução', { status: 'encerrada' }),
        ...common,
      },
    },
  },
  '/disparador/campaigns/{id}/resume': {
    post: {
      tags: ['Disparador'],
      operationId: 'resumeCampaign',
      summary: 'Retomar campanha',
      description: [
        'Exige `campaigns:write`. Retoma uma campanha **pausada**; já em execução devolve `200` com `changed: false`. 30 req/min por chave.',
        '',
        '**Guardas (409):** pausada pelo motor (taxa de erro etc.) só retoma com `acknowledge_auto_pause: true` (`details.code = auto_paused`); template da campanha sem aprovação na Meta (`template_not_approved`); número em qualidade vermelha (`red_quality`: a confirmação é do proprietário, na tela, e a API nunca a dá).',
      ].join('\n'),
      parameters: [idParam],
      requestBody: jsonBody('ResumeCampaignRequest', { acknowledge_auto_pause: true }),
      responses: {
        '200': controlOk('Campanha retomada (ou já estava em execução).', { campaign_id: '7c9e6679-0000-4000-8000-000000000020', status: 'em_execucao', previous_status: 'pausada', changed: true }),
        '400': apiError('Corpo inválido.', 'bad_request', "'acknowledge_auto_pause' deve ser true ou false"),
        '404': notFound,
        '409': stateConflict('A campanha foi pausada automaticamente; confirme com acknowledge_auto_pause depois de corrigir a causa', { status: 'pausada', code: 'auto_paused', reason: 'Taxa de erro acima do limite' }),
        ...common,
      },
    },
  },
  '/disparador/campaigns/{id}/cancel': {
    post: {
      tags: ['Disparador'],
      operationId: 'cancelCampaign',
      summary: 'Cancelar campanha',
      description: 'Exige `campaigns:write`. **Irreversível**: exige `{ "confirm": true }`. Encerra a campanha e cancela os itens agendados/pausados; itens já em envio seguem. Só cancela campanha em execução, pausada ou agendada. Já encerrada devolve `200` com `changed: false`. 30 req/min por chave.',
      parameters: [idParam],
      requestBody: jsonBody('CancelCampaignRequest', { confirm: true }, true),
      responses: {
        '200': controlOk('Campanha cancelada (ou já estava encerrada).', { campaign_id: '7c9e6679-0000-4000-8000-000000000020', status: 'encerrada', previous_status: 'pausada', changed: true, items_pending_move: false }),
        '400': apiError('Falta a confirmação.', 'bad_request', 'Cancelar é irreversível: envie { "confirm": true } para confirmar'),
        '404': notFound,
        '409': stateConflict('Só é possível cancelar uma campanha em execução, pausada ou agendada', { status: 'rascunho' }),
        ...common,
      },
    },
  },
  '/disparador/campaigns/{id}/recipients/remove': {
    post: {
      tags: ['Disparador'],
      operationId: 'removeCampaignRecipients',
      summary: 'Tirar destinatários da campanha',
      description: [
        `Exige \`campaigns:write\`. Tira da campanha destinatários **ainda não enviados** (ex.: o cliente pagou). De 1 a ${REMOVE_MAX_RECIPIENTS} itens por chamada; cada item informa pelo menos um de \`phone\`, \`cpf\` ou \`reference\`. 30 req/min por chave.`,
        '',
        '**Não é opt-out:** a lista de bloqueio não é tocada; o cliente pode receber outra campanha. **Idempotente:** repetir devolve `already_removed`.',
        '',
        'Resultado por item (na ordem enviada): `removed` (cancelado agora), `already_removed`, `in_flight` (está sendo enviado neste instante; repita depois), `already_sent` (já enviado/entregue/lido, não se desfaz), `not_found` (não está nesta campanha) e `invalid` (entrada inválida; as demais seguem). O `cpf` acha só quem já é contato do CRM e **nunca é devolvido**.',
      ].join('\n'),
      parameters: [idParam],
      requestBody: jsonBody(
        'RemoveRecipientsRequest',
        { reason: 'paid', recipients: [{ phone: '+5521999998888' }, { cpf: '123.456.789-09' }, { reference: 'contrato-8841' }] },
        true,
      ),
      responses: {
        '200': {
          description: 'Resultado por item.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: ref('RemoveRecipientsResponse') } },
              example: {
                data: {
                  results: [
                    { index: 0, status: 'removed', items: 1 },
                    { index: 1, status: 'already_sent', items: 1 },
                    { index: 2, status: 'not_found', items: 0 },
                  ],
                  items_removed: 1,
                  removed: 1,
                  already_removed: 0,
                  in_flight: 0,
                  already_sent: 1,
                  not_found: 1,
                  invalid: 0,
                },
              },
            },
          },
        },
        '400': apiError('Corpo inválido.', 'bad_request', "'recipients' é obrigatório e não pode ser vazio"),
        '404': notFound,
        '503': apiError('Migration 357 ainda não aplicada no banco.', 'unavailable', 'Remoção de destinatários indisponível: aplique a migration 357'),
        ...common,
      },
    },
  },
};

export const campaignPaths: Record<string, Json> = {
  ...campaignControlPaths,
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
  ended_reason: { type: ['string', 'null'], enum: ['completed', 'cancelled', 'cancelled_api', null], description: 'Só com a campanha encerrada: concluída, cancelada na tela ou cancelada pela API.' },
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
  CampaignControlResult: {
    type: 'object',
    properties: {
      campaign_id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: [...CAMPAIGN_STATUSES] },
      previous_status: { type: 'string', enum: [...CAMPAIGN_STATUSES] },
      changed: { type: 'boolean', description: '`false` = já estava no estado pedido (repetição idempotente).' },
      items_pending_move: { type: 'boolean', description: 'Só em pause/cancel: os itens ainda estão sendo movidos em segundo plano (campanha grande).' },
    },
  },
  PauseCampaignRequest: { type: 'object', properties: { reason: { type: 'string', maxLength: 200, description: 'Motivo, visível no painel e no detalhe.' } } },
  ResumeCampaignRequest: {
    type: 'object',
    properties: { acknowledge_auto_pause: { type: 'boolean', description: 'Obrigatório para retomar uma campanha pausada pelo motor.' } },
  },
  CancelCampaignRequest: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'boolean', enum: [true] } } },
  RemoveRecipientsRequest: {
    type: 'object',
    required: ['recipients'],
    properties: {
      reason: { type: 'string', enum: [...REMOVE_REASONS], default: 'other' },
      recipients: {
        type: 'array',
        minItems: 1,
        maxItems: REMOVE_MAX_RECIPIENTS,
        items: {
          type: 'object',
          description: 'Pelo menos um identificador.',
          properties: {
            phone: { type: 'string', description: 'Telefone com DDI; tolera o 9º dígito.' },
            cpf: { type: 'string', description: 'CPF de um contato do CRM (com ou sem máscara). Nunca é devolvido.' },
            reference: { type: 'string', maxLength: 64, description: '`reference` enviada no create da campanha.' },
          },
        },
      },
    },
  },
  RemoveRecipientsResponse: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            status: { type: 'string', enum: [...REMOVE_ENTRY_STATUSES] },
            items: { type: 'integer', description: 'Itens da fila encontrados para o identificador.' },
            message: { type: 'string', description: 'Só em `invalid`.' },
          },
        },
      },
      items_removed: { type: 'integer', description: 'Itens da fila cancelados nesta chamada.' },
      removed: { type: 'integer' },
      already_removed: { type: 'integer' },
      in_flight: { type: 'integer' },
      already_sent: { type: 'integer' },
      not_found: { type: 'integer' },
      invalid: { type: 'integer' },
    },
  },
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
      reference: { type: ['string', 'null'], description: '`reference` enviada no create da campanha, se houve.' },
      status: { type: 'string', enum: [...RECIPIENT_STATUSES], description: 'Estado atual (não cumulativo). `removed`: tirado pela API antes do envio; `cancelled`: cancelado com a campanha.' },
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
