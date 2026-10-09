// OpenAPI dos webhooks de SAÍDA (PRD 15, 15.14): rotas /webhooks, schemas e o guia de assinatura/retry.
// Mesclado em openapi.ts (paths, schemas, tags e descrição). Sem segredo: só contrato.
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS, MAX_DELIVERY_ATTEMPTS, MAX_ENDPOINTS_PER_ACCOUNT } from '@/lib/webhooks-out/catalog';

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const errorExample = (code: string, message: string): Json => ({ error: { code, message } });
const apiError = (description: string, code: string, message: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: errorExample(code, message) } },
});
const idParam = { name: 'id', in: 'path', required: true, description: 'ID do webhook.', schema: { type: 'string', format: 'uuid' } };
const common = { '401': resp('Unauthorized'), '403': resp('Forbidden'), '429': resp('RateLimited'), '500': resp('InternalError') };
const unavailable = apiError('Migration 204 ainda não aplicada no banco.', 'unavailable', 'Webhooks de saída indisponíveis: aplique a migration 204');

const endpointExample = {
  id: '9d3c2f1e-0000-4000-8000-000000000050',
  url: 'https://erp.cliente.com.br/hooks/crm',
  description: 'ERP de cobrança',
  events: ['message.received', 'agreement.created'],
  status: 'active',
  consecutive_failures: 0,
  last_success_at: '2026-10-09T14:00:00.000Z',
  last_failure_at: null,
  created_at: '2026-10-09T12:00:00.000Z',
};

export const WEBHOOK_GUIDE = [
  '',
  '## Webhooks de saída',
  `O CRM chama a sua URL (**https**, endereço público) quando algo acontece — sem polling. Cadastre até ${MAX_ENDPOINTS_PER_ACCOUNT} endpoints por conta com \`POST /webhooks\` (escopo \`webhooks:write\`); o segredo \`whsec_…\` vem **uma única vez** na criação (ou em \`/rotate-secret\`).`,
  '',
  '**Eventos:** ' + WEBHOOK_EVENTS.map((e) => `\`${e}\` (${WEBHOOK_EVENT_DESCRIPTIONS[e].replace(/\.$/, '')})`).join(' · ') + '. Existe ainda `webhook.test`, enviado só pelo `POST /webhooks/{id}/test`.',
  '',
  '**Corpo (JSON):** `{ "id": "<uuid do evento>", "type": "message.received", "created_at": "…Z", "account_id": "…", "data": { … } }`. Cabeçalhos: `X-CRM-Event`, `X-CRM-Delivery` (id da entrega), `X-CRM-Attempt` (1…12) e `X-CRM-Signature`.',
  '',
  '**Assinatura:** `X-CRM-Signature: t=<unix>,v1=<hex>` onde `v1 = HMAC_SHA256(segredo, t + "." + corpo_bruto)`. Recalcule sobre o corpo **bruto** recebido (antes de parsear), compare em tempo constante e **rejeite se |agora − t| > 5 minutos** (anti-replay).',
  '',
  '**Resposta esperada:** qualquer `2xx` em até 10 s (o corpo da resposta é ignorado). Redirecionamentos **não** são seguidos.',
  '',
  `**Retry:** falha (não-2xx, timeout, erro de rede) repete com backoff exponencial de 30 s · 2^n (teto de 1 h, com variação de ±10 %), até **${MAX_DELIVERY_ATTEMPTS} tentativas** (~18 h); depois a entrega vira \`dead\` e fica visível em \`GET /webhooks/{id}/deliveries?state=dead\` (reenvie com \`POST …/replay\`). Endereço bloqueado pelo guard de rede (IP privado/interno) vira \`dead\` na hora.`,
  '',
  '**Garantias:** *pelo menos uma vez* e **sem ordem garantida** entre eventos. Deduplique pelo `id` do evento (igual em reentregas). Endpoint `paused` não recebe: as entregas aguardam até você reativá-lo.',
  '',
  '**Dados pessoais:** `message.received` carrega telefone e texto do cliente; trate o seu endpoint como dado sensível (HTTPS, validação da assinatura, sem log do corpo).',
].join('\n');

export const webhookTags = [{ name: 'Webhooks', description: 'Webhooks de saída assinados (escopos webhooks:read / webhooks:write).' }];

export const webhookPaths: Record<string, Json> = {
  '/webhooks': {
    get: {
      tags: ['Webhooks'],
      operationId: 'listWebhooks',
      summary: 'Lista os webhooks da conta',
      description: 'Exige `webhooks:read` **ou** `webhooks:write`. O segredo nunca é devolvido.',
      responses: {
        '200': {
          description: 'Endpoints cadastrados (mais recentes primeiro).',
          content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: ref('Webhook') } } }, example: { data: [endpointExample] } } },
        },
        '503': unavailable,
        ...common,
      },
    },
    post: {
      tags: ['Webhooks'],
      operationId: 'createWebhook',
      summary: 'Cadastra um webhook',
      description: `Exige \`webhooks:write\`. \`url\` precisa ser **https** e pública (IP privado/interno é recusado). Até ${MAX_ENDPOINTS_PER_ACCOUNT} por conta. **O \`secret\` é devolvido só aqui** — guarde-o para validar a assinatura.`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: ref('WebhookCreateRequest'),
            example: { url: 'https://erp.cliente.com.br/hooks/crm', events: ['message.received', 'agreement.created'], description: 'ERP de cobrança' },
          },
        },
      },
      responses: {
        '201': {
          description: 'Webhook criado (com o segredo).',
          content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: ref('WebhookCreated') } }, example: { data: { ...endpointExample, secret: 'whsec_exemplo-guarde-este-valor' } } } },
        },
        '400': apiError('URL não https/pública, eventos desconhecidos ou corpo inválido.', 'bad_request', '`events` deve listar ao menos um evento entre: message.received, …'),
        '409': apiError('Limite de endpoints por conta atingido.', 'conflict', `Limite de ${MAX_ENDPOINTS_PER_ACCOUNT} endpoints por conta atingido`),
        '413': apiError('Corpo acima de 16 KB.', 'payload_too_large', 'Corpo grande demais (máx. 16 KB)'),
        '503': unavailable,
        ...common,
      },
    },
  },
  '/webhooks/{id}': {
    get: {
      tags: ['Webhooks'],
      operationId: 'getWebhook',
      summary: 'Lê um webhook',
      description: 'Exige `webhooks:read` **ou** `webhooks:write`. De outra conta (ou id inválido) devolve `404`.',
      parameters: [idParam],
      responses: {
        '200': { description: 'O webhook (sem segredo).', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: ref('Webhook') } }, example: { data: endpointExample } } } },
        '404': apiError('Webhook inexistente ou de outra conta.', 'not_found', 'Webhook não encontrado'),
        '503': unavailable,
        ...common,
      },
    },
    patch: {
      tags: ['Webhooks'],
      operationId: 'updateWebhook',
      summary: 'Altera um webhook',
      description: 'Exige `webhooks:write`. Informe ao menos um de `url`, `events`, `description`, `status` (`active`|`paused`). Pausar interrompe o envio sem perder as entregas pendentes.',
      parameters: [idParam],
      requestBody: { required: true, content: { 'application/json': { schema: ref('WebhookUpdateRequest'), example: { status: 'paused' } } } },
      responses: {
        '200': { description: 'O webhook atualizado.', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: ref('Webhook') } } } } },
        '400': apiError('Campo inválido ou corpo vazio.', 'bad_request', 'Informe ao menos um campo: url, events, description ou status'),
        '404': apiError('Webhook inexistente ou de outra conta.', 'not_found', 'Webhook não encontrado'),
        '413': apiError('Corpo acima de 16 KB.', 'payload_too_large', 'Corpo grande demais (máx. 16 KB)'),
        '503': unavailable,
        ...common,
      },
    },
    delete: {
      tags: ['Webhooks'],
      operationId: 'deleteWebhook',
      summary: 'Apaga um webhook',
      description: 'Exige `webhooks:write`. Apaga também o histórico de entregas do endpoint.',
      parameters: [idParam],
      responses: {
        '200': { description: 'Apagado.', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, deleted: { type: 'boolean' } } } } } } } },
        '404': apiError('Webhook inexistente ou de outra conta.', 'not_found', 'Webhook não encontrado'),
        '503': unavailable,
        ...common,
      },
    },
  },
  '/webhooks/{id}/deliveries': {
    get: {
      tags: ['Webhooks'],
      operationId: 'listWebhookDeliveries',
      summary: 'Histórico de entregas',
      description: 'Exige `webhooks:read` **ou** `webhooks:write`. Mais recentes primeiro, paginação por cursor. Não devolve o corpo enviado nem o segredo.',
      parameters: [
        idParam,
        { name: 'state', in: 'query', required: false, description: 'Filtra por estado.', schema: { type: 'string', enum: ['pending', 'sending', 'delivered', 'dead'] } },
        { name: 'cursor', in: 'query', required: false, description: '`next_cursor` da página anterior.', schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, description: 'Itens por página (padrão 50, máx. 200).', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      ],
      responses: {
        '200': {
          description: 'Página de entregas.',
          content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'object', properties: { items: { type: 'array', items: ref('WebhookDelivery') }, next_cursor: { type: ['string', 'null'] } } } } } } },
        },
        '400': apiError('`state` ou `cursor` inválido.', 'bad_request', '`cursor` inválido'),
        '404': apiError('Webhook inexistente ou de outra conta.', 'not_found', 'Webhook não encontrado'),
        '503': unavailable,
        ...common,
      },
    },
  },
  '/webhooks/{id}/deliveries/{deliveryId}/replay': {
    post: {
      tags: ['Webhooks'],
      operationId: 'replayWebhookDelivery',
      summary: 'Reenvia uma entrega esgotada',
      description: 'Exige `webhooks:write`. Só entregas `dead` deste webhook; zera as tentativas e reentra na fila.',
      parameters: [idParam, { name: 'deliveryId', in: 'path', required: true, description: 'ID da entrega (`X-CRM-Delivery`).', schema: { type: 'string', format: 'uuid' } }],
      responses: {
        '202': { description: 'Reenfileirada.', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, state: { type: 'string', enum: ['pending'] } } } } } } } },
        '404': apiError('Webhook ou entrega inexistente / de outra conta.', 'not_found', 'Webhook não encontrado'),
        '409': apiError('A entrega não está `dead`.', 'conflict', "Só entregas com estado 'dead' deste webhook podem ser reenviadas"),
        '503': unavailable,
        ...common,
      },
    },
  },
  '/webhooks/{id}/rotate-secret': {
    post: {
      tags: ['Webhooks'],
      operationId: 'rotateWebhookSecret',
      summary: 'Gera um novo segredo',
      description: 'Exige `webhooks:write`. O segredo anterior deixa de valer imediatamente (entregas pendentes já saem assinadas com o novo). O novo `secret` é devolvido **uma única vez**.',
      parameters: [idParam],
      responses: {
        '200': { description: 'Novo segredo.', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, secret: { type: 'string' } } } } } } } },
        '404': apiError('Webhook inexistente ou de outra conta.', 'not_found', 'Webhook não encontrado'),
        '503': unavailable,
        ...common,
      },
    },
  },
  '/webhooks/{id}/test': {
    post: {
      tags: ['Webhooks'],
      operationId: 'testWebhook',
      summary: 'Envia um evento de teste',
      description: 'Exige `webhooks:write`. Enfileira um `webhook.test` só para este endpoint; a entrega sai no próximo ciclo (≈1 min) e aparece em `GET …/deliveries`.',
      parameters: [idParam],
      responses: {
        '202': { description: 'Enfileirado.', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'object', properties: { delivery_id: { type: 'string', format: 'uuid' } } } } } } } },
        '404': apiError('Webhook inexistente ou de outra conta.', 'not_found', 'Webhook não encontrado'),
        '503': unavailable,
        ...common,
      },
    },
  },
};

export const webhookSchemas: Record<string, Json> = {
  Webhook: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      url: { type: 'string', format: 'uri' },
      description: { type: ['string', 'null'] },
      events: { type: 'array', items: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
      status: { type: 'string', enum: ['active', 'paused'] },
      consecutive_failures: { type: 'integer', description: 'Falhas seguidas desde o último sucesso.' },
      last_success_at: { type: ['string', 'null'], format: 'date-time' },
      last_failure_at: { type: ['string', 'null'], format: 'date-time' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  WebhookCreated: {
    allOf: [ref('Webhook'), { type: 'object', required: ['secret'], properties: { secret: { type: 'string', description: 'Segredo `whsec_…` (só nesta resposta).' } } }],
  },
  WebhookCreateRequest: {
    type: 'object',
    required: ['url', 'events'],
    properties: {
      url: { type: 'string', format: 'uri', pattern: '^https://', description: 'URL https pública que recebe os eventos.' },
      events: { type: 'array', minItems: 1, items: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
      description: { type: 'string', maxLength: 200 },
    },
  },
  WebhookUpdateRequest: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', pattern: '^https://' },
      events: { type: 'array', minItems: 1, items: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
      description: { type: ['string', 'null'], maxLength: 200 },
      status: { type: 'string', enum: ['active', 'paused'] },
    },
  },
  WebhookDelivery: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Igual ao header `X-CRM-Delivery`.' },
      event: { type: 'string' },
      event_id: { type: 'string', format: 'uuid', description: 'Igual ao `id` do evento no corpo (deduplique por ele).' },
      state: { type: 'string', enum: ['pending', 'sending', 'delivered', 'dead'] },
      attempts: { type: 'integer', minimum: 0, maximum: MAX_DELIVERY_ATTEMPTS },
      next_attempt_at: { type: 'string', format: 'date-time' },
      last_status: { type: ['integer', 'null'], description: 'HTTP da última tentativa (null = falha de rede).' },
      last_error: { type: ['string', 'null'], description: 'Motivo curto, sem corpo.' },
      created_at: { type: 'string', format: 'date-time' },
      delivered_at: { type: ['string', 'null'], format: 'date-time' },
    },
  },
};
