// OpenAPI da EXTRAÇÃO de conversas e mensagens (TASK38): rotas /conversations, /conversations/{id}/messages e /messages, schemas e guia.
// Mesclado em openapi.ts (paths, schemas, tags e descrição), no mesmo padrão de openapi-webhooks.ts. Sem segredo: só contrato.

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const errorExample = (code: string, message: string): Json => ({ error: { code, message } });
const apiError = (description: string, code: string, message: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: errorExample(code, message) } },
});
const common = { '401': resp('Unauthorized'), '403': resp('Forbidden'), '429': resp('RateLimited'), '500': resp('InternalError') };
const unavailable = apiError('Migration 330 ainda não aplicada no banco.', 'unavailable', 'Extração de mensagens indisponível: aplique a migration 330.');

export const EXTRACT_GUIDE = [
  '',
  '## Extração de conversas e mensagens',
  'Para BI, auditoria e arquivo. Somente leitura, sempre **da conta da chave**. Três rotas: `GET /conversations` (escopo `conversations:read`), `GET /conversations/{id}/messages` e `GET /messages` (escopo `messages:read`).',
  '',
  '**Ordem e paginação:** as mensagens vêm em ordem cronológica `(created_at, id)` **ascendente**; as conversas por `updated_at` (ou `closed_at`, se usar `closed_from`/`closed_to`), também ascendente, o que permite extração incremental (guarde o último `updated_at` e volte com `updated_from`). Paginação por **`cursor`** opaco: repasse o `next_cursor` da resposta; `null` = fim. Não há buracos nem repetição entre páginas. Cada `seq` é a posição da mensagem na conversa (1…N) e não muda entre chamadas.',
  '',
  '**Autor (`author`):** `type` ∈ `customer`, `operator`, `ai`, `flow`, `campaign`, `automation`, `api`. `operator` traz `id` e `name` do atendente; `customer` traz o contato; os demais têm `id` e `name` nulos. Mensagens antigas sem origem registrada aparecem como `automation` (exceto as do cliente e as de atendente identificado).',
  '',
  '**Mídia:** `media` descreve o anexo (`type`, `mime`, `filename`, `size`) **sem URL**. O mime e o nome são deduzidos do arquivo; `size` pode vir nulo (o tamanho não é gravado). Com `include_media_urls=true` cada anexo ganha `media.url`, uma URL assinada que expira em **15 minutos**. As variáveis de um template não são gravadas na mensagem: `template.variables` vem nulo e o texto já renderizado, quando existe, vai em `text`.',
  '',
  '**O que não sai:** chat interno entre operadores, notas internas, dados de prompt/decisão da IA e dados sensíveis do contato (CPF etc.; o contato é só `id`, `name` e `phone`). Cada extração é **auditada** (chave, rota, filtros e quantidade; nunca o conteúdo).',
  '',
  '**Limites:** 60 requisições por minuto por chave nestas três rotas (além dos 120/min gerais); `429` com `Retry-After`. `GET /messages` aceita no máximo **31 dias** por chamada (`from` inclusivo, `to` exclusivo).',
].join('\n');

export const extractTags = [{ name: 'Extração', description: 'Conversas e mensagens para BI/auditoria (escopos conversations:read e messages:read).' }];

const cursorParam = { name: 'cursor', in: 'query', required: false, description: 'Cursor opaco devolvido em `next_cursor` da página anterior.', schema: { type: 'string' } };
const mediaParam = {
  name: 'include_media_urls',
  in: 'query',
  required: false,
  description: 'Se `true`, cada anexo traz `media.url` (assinada, 15 minutos). Padrão: sem URL.',
  schema: { type: 'boolean', default: false },
};
const messageLimit = { name: 'limit', in: 'query', required: false, description: 'Itens por página (1 a 1000).', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 500 } };
const isoParam = (name: string, description: string, required = false) => ({
  name, in: 'query', required, description, schema: { type: 'string', format: 'date-time' }, example: '2026-10-01T00:00:00Z',
});

const messageExample = {
  id: '3f0c9b1a-0000-4000-8000-000000000101',
  conversation_id: '7a1d3c50-0000-4000-8000-000000000201',
  seq: 3,
  created_at: '2026-10-08T14:03:22.114Z',
  direction: 'outbound',
  author: { type: 'operator', id: '5b0e5a64-0000-4000-8000-000000000031', name: 'Ana Souza' },
  content_type: 'text',
  text: 'Posso te ajudar com a renegociação.',
  template: null,
  media: null,
  status: 'read',
  reply_to_id: null,
  campaign_id: null,
};

const messagePage = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { type: 'object', required: ['data'], properties: { data: ref('MessagePage') } },
      example: { data: { items: [messageExample], next_cursor: 'WyIyMDI2LTEwLTA4VDE0OjAzOjIyLjExNDExMiswMDowMCIsIjNmMGM5YjFhIl0' } },
    },
  },
});

export const extractPaths: Record<string, Json> = {
  '/conversations': {
    get: {
      tags: ['Extração'],
      operationId: 'listConversations',
      summary: 'Listar conversas (extração)',
      description:
        'Conversas da conta da chave, em ordem ascendente de `updated_at` (ou de `closed_at` quando `closed_from`/`closed_to` são usados), com equipe, atendente, tabulação, contato, `message_count` e o histórico de transferências. Exige `conversations:read`.',
      parameters: [
        isoParam('updated_from', 'Atualizadas a partir de (inclusivo).'),
        isoParam('updated_to', 'Atualizadas até (exclusivo).'),
        isoParam('closed_from', 'Encerradas a partir de (inclusivo). Usar `closed_*` ordena por encerramento.'),
        isoParam('closed_to', 'Encerradas até (exclusivo).'),
        { name: 'status', in: 'query', required: false, description: 'Situação da conversa.', schema: { type: 'string', enum: ['open', 'pending', 'closed'] } },
        { name: 'channel', in: 'query', required: false, description: 'Canal (ex.: `whatsapp`, `webchat`).', schema: { type: 'string' } },
        { name: 'team_id', in: 'query', required: false, description: 'Equipe (UUID).', schema: { type: 'string', format: 'uuid' } },
        { name: 'contact_id', in: 'query', required: false, description: 'Contato (UUID).', schema: { type: 'string', format: 'uuid' } },
        { name: 'phone', in: 'query', required: false, description: 'Telefone do contato (só dígitos; com ou sem 55).', schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, description: 'Itens por página (1 a 500).', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        cursorParam,
      ],
      responses: {
        '200': {
          description: 'Página de conversas.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: ref('ConversationPage') } },
              example: {
                data: {
                  items: [
                    {
                      id: '7a1d3c50-0000-4000-8000-000000000201',
                      channel: 'whatsapp',
                      status: 'closed',
                      created_at: '2026-10-08T14:00:00.000Z',
                      updated_at: '2026-10-08T14:20:00.000Z',
                      first_response_at: '2026-10-08T14:01:30.000Z',
                      closed_at: '2026-10-08T14:20:00.000Z',
                      team: { id: '5b0e5a64-0000-4000-8000-000000000031', name: 'Cobrança Graduação' },
                      assigned_agent: { id: '5b0e5a64-0000-4000-8000-000000000032', name: 'Ana Souza' },
                      outcome_tag: { id: '9d3c2f1e-0000-4000-8000-000000000050', name: 'Acordo fechado', codigo: 7 },
                      contact: { id: 'c1d2e3f4-0000-4000-8000-000000000301', name: 'Carlos Lima', phone: '5511999998888' },
                      message_count: 12,
                      assignments: [
                        { at: '2026-10-08T14:00:05.000Z', from_agent: null, to_agent: null, from_team: null, to_team: { id: '5b0e5a64-0000-4000-8000-000000000031', name: 'Cobrança Graduação' }, reason: 'fluxo' },
                      ],
                    },
                  ],
                  next_cursor: null,
                },
              },
            },
          },
        },
        '400': apiError('Filtro, `limit` ou `cursor` inválido.', 'bad_request', "'status' deve ser open, pending ou closed"),
        ...common,
        '503': unavailable,
      },
    },
  },
  '/conversations/{id}/messages': {
    get: {
      tags: ['Extração'],
      operationId: 'listConversationMessages',
      summary: 'Mensagens de uma conversa (em ordem)',
      description:
        'Todas as mensagens da conversa em ordem cronológica `(created_at, id)`, com `seq` estável, autor, conteúdo e mídia (sem URL por padrão). Conversa de outra conta responde `404`. Exige `messages:read`.',
      parameters: [
        { name: 'id', in: 'path', required: true, description: 'ID da conversa.', schema: { type: 'string', format: 'uuid' } },
        messageLimit,
        cursorParam,
        mediaParam,
      ],
      responses: {
        '200': messagePage('Página de mensagens da conversa.'),
        '400': apiError('`limit` ou `cursor` inválido.', 'bad_request', "'cursor' inválido"),
        '404': apiError('Conversa inexistente ou de outra conta.', 'not_found', 'Conversa não encontrada'),
        ...common,
        '503': unavailable,
      },
    },
  },
  '/messages': {
    get: {
      tags: ['Extração'],
      operationId: 'listMessages',
      summary: 'Extração em massa de mensagens por período',
      description:
        'Mensagens de **todas as conversas** da conta no período `[from, to)`, em ordem `(created_at, id)`. `from` e `to` são obrigatórios e o período é de no máximo **31 dias** por chamada (para mais, extraia em blocos). Mesmo formato de `/conversations/{id}/messages`; `seq` é a posição da mensagem na conversa dela. Exige `messages:read`.',
      parameters: [
        isoParam('from', 'Início do período (inclusivo), ISO 8601.', true),
        isoParam('to', 'Fim do período (exclusivo), ISO 8601. No máximo 31 dias depois de `from`.', true),
        { name: 'channel', in: 'query', required: false, description: 'Canal (ex.: `whatsapp`, `webchat`).', schema: { type: 'string' } },
        { name: 'team_id', in: 'query', required: false, description: 'Equipe da conversa (UUID).', schema: { type: 'string', format: 'uuid' } },
        messageLimit,
        cursorParam,
        mediaParam,
      ],
      responses: {
        '200': messagePage('Página de mensagens do período.'),
        '400': apiError('`from`/`to` ausentes ou inválidos, período acima de 31 dias, ou `limit`/`cursor` inválido.', 'bad_request', "O período máximo é de 31 dias por chamada"),
        ...common,
        '503': unavailable,
      },
    },
  },
};

const person = (description: string) => ({
  description,
  oneOf: [{ type: 'null' }, { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: ['string', 'null'] } } }],
});

export const extractSchemas: Record<string, Json> = {
  ApiMessageAuthor: {
    type: 'object',
    required: ['type', 'id', 'name'],
    properties: {
      type: { type: 'string', enum: ['customer', 'operator', 'ai', 'flow', 'campaign', 'automation', 'api'], description: 'Origem da mensagem. Histórico antigo sem origem = `automation`.' },
      id: { type: ['string', 'null'], format: 'uuid', description: 'Atendente (`operator`) ou contato (`customer`); nulo nos demais.' },
      name: { type: ['string', 'null'] },
    },
  },
  ApiMessage: {
    type: 'object',
    required: ['id', 'conversation_id', 'seq', 'created_at', 'direction', 'author', 'content_type'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      conversation_id: { type: 'string', format: 'uuid' },
      seq: { type: 'integer', minimum: 1, description: 'Posição da mensagem na conversa (1…N), estável.' },
      created_at: { type: 'string', format: 'date-time', description: 'ISO 8601 em UTC.' },
      direction: { type: 'string', enum: ['inbound', 'outbound'] },
      author: ref('ApiMessageAuthor'),
      content_type: { type: 'string', description: 'text, image, audio, video, document, template, interactive, location, sticker, poll, vcard ou revoked.' },
      text: { type: ['string', 'null'] },
      template: {
        description: 'Quando a mensagem é de template. `variables` não é gravado na mensagem (sempre nulo).',
        oneOf: [{ type: 'null' }, { type: 'object', required: ['name', 'variables'], properties: { name: { type: 'string' }, variables: { type: 'null' } } }],
      },
      media: {
        description: 'Anexo, SEM URL por padrão (`include_media_urls=true` acrescenta `url`, assinada, 15 minutos).',
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            required: ['type', 'mime', 'filename', 'size'],
            properties: { type: { type: 'string' }, mime: { type: ['string', 'null'] }, filename: { type: ['string', 'null'] }, size: { type: ['integer', 'null'] }, url: { type: 'string', format: 'uri' } },
          },
        ],
      },
      status: { type: ['string', 'null'], description: 'sending, sent, delivered, read ou failed.' },
      reply_to_id: { type: ['string', 'null'], format: 'uuid' },
      campaign_id: { type: ['string', 'null'], format: 'uuid', description: 'Campanha do Disparador, quando a mensagem veio de um disparo.' },
    },
  },
  MessagePage: {
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items: ref('ApiMessage') }, next_cursor: { type: ['string', 'null'], description: 'Cursor da próxima página; `null` no fim.' } },
  },
  ApiConversation: {
    type: 'object',
    required: ['id', 'channel', 'status', 'created_at', 'message_count', 'assignments'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      channel: { type: 'string' },
      status: { type: 'string', enum: ['open', 'pending', 'closed'] },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: ['string', 'null'], format: 'date-time' },
      first_response_at: { type: ['string', 'null'], format: 'date-time' },
      closed_at: { type: ['string', 'null'], format: 'date-time' },
      team: person('Equipe da conversa.'),
      assigned_agent: person('Atendente atual.'),
      outcome_tag: {
        description: 'Tabulação do encerramento.',
        oneOf: [{ type: 'null' }, { type: 'object', required: ['id', 'name', 'codigo'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: ['string', 'null'] }, codigo: { type: ['integer', 'null'] } } }],
      },
      contact: {
        description: 'Só `id`, `name` e `phone`: nenhum dado sensível do contato (CPF etc.) é exposto.',
        oneOf: [{ type: 'null' }, { type: 'object', required: ['id', 'name', 'phone'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] } } }],
      },
      message_count: { type: 'integer' },
      assignments: {
        type: 'array',
        description: 'Histórico de transferências, em ordem cronológica.',
        items: {
          type: 'object',
          required: ['at', 'from_agent', 'to_agent', 'from_team', 'to_team', 'reason'],
          properties: {
            at: { type: 'string', format: 'date-time' },
            from_agent: person('Atendente de origem.'),
            to_agent: person('Atendente de destino.'),
            from_team: person('Equipe de origem.'),
            to_team: person('Equipe de destino.'),
            reason: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
  ConversationPage: {
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items: ref('ApiConversation') }, next_cursor: { type: ['string', 'null'] } },
  },
};
