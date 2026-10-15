// OpenAPI dos TEMPLATES (bloco D da Onda 1): GET /templates e POST /whatsapp/send-template, schemas e guia.
// Mesclado em openapi.ts (paths, schemas, tags e descrição), no mesmo padrão de openapi-extract.ts. Sem segredo: só contrato.

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const errorExample = (code: string, message: string): Json => ({ error: { code, message } });
const apiError = (description: string, code: string, message: string, extra: Json = {}) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: { error: { code, message, ...extra } } } },
});

export const TEMPLATES_GUIDE = [
  '',
  '## Templates (Meta)',
  '`GET /templates` lista os templates da conta (padrão: só os **APROVADOS**) com nome, idioma, **quantas variáveis** o corpo pede (`placeholders.body`) e se o template pode ser enviado por `POST /whatsapp/send-template` (`sendable_via_api`; se `false`, o motivo vem em `unsupported_reason`). Exige `templates:read` (ou `messages:send` / `campaigns:write`, que já usam templates).',
  '',
  '`POST /whatsapp/send-template` envia **um** template a **um** número. Só funciona em canal **Meta** (canal WAHA responde `422`; use `/whatsapp/send` com texto). Passo a passo: (1) liste com `GET /templates`; (2) envie `to`, `template.name`, `template.language` e `variables` (uma por `{{n}}` do corpo, na ordem); (3) guarde o `message_id`. Cabeçalho de mídia, link dinâmico, copiar código e botão de Flow **não** são preenchidos por esta rota (aparecem como `sendable_via_api: false`). Para volume, use campanha (`POST /disparador/campaigns`): aqui o limite é de **60 envios por minuto por chave** (além dos 120/min gerais). O link do template não é rastreado pelo UTMpay nesta rota.',
].join('\n');


const common = { '401': resp('Unauthorized'), '403': resp('Forbidden'), '429': resp('RateLimited'), '500': resp('InternalError') };

const templateExample = {
  id: '8c1f3b52-0000-4000-8000-000000000401',
  name: 'lembrete_vencimento',
  language: 'pt_BR',
  category: 'UTILITY',
  status: 'APPROVED',
  waba_id: '109876543210987',
  channels: [{ id: '5b0e5a64-0000-4000-8000-000000000011', label: '+55 27 99999-1212' }],
  placeholders: { body: 2, examples: ['Ana', '150,00'] },
  body: 'Olá, {{1}}! Sua parcela de R$ {{2}} vence amanhã.',
  header_type: null,
  buttons: ['QUICK_REPLY'],
  quality: 'GREEN',
  sendable_via_api: true,
  unsupported_reason: null,
  updated_at: '2026-10-14T12:00:00.000Z',
};

export const templatesPaths: Record<string, Json> = {
  '/templates': {
    get: {
      tags: ['Mensagens'],
      operationId: 'listTemplates',
      summary: 'Listar templates da Meta',
      description:
        'Templates da conta, em ordem de `name` e `id`. Por padrão só os **APROVADOS**. Use `channel` para ver só os da WABA de um canal. `placeholders.body` é o nº de variáveis que o envio exige; `sendable_via_api` diz se `POST /whatsapp/send-template` aceita o template. Sem dado pessoal. Exige `templates:read` (ou `messages:send` / `campaigns:write`).',
      parameters: [
        { name: 'status', in: 'query', required: false, description: 'Situação na Meta. Padrão `APPROVED`; `all` traz todas.', schema: { type: 'string', enum: ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DRAFT', 'all'], default: 'APPROVED' } },
        { name: 'language', in: 'query', required: false, description: 'Idioma (ex.: `pt_BR`).', schema: { type: 'string' } },
        { name: 'name', in: 'query', required: false, description: 'Prefixo do nome do template (letras minúsculas, números e `_`).', schema: { type: 'string' } },
        { name: 'channel', in: 'query', required: false, description: 'Canal Meta (UUID ou número): só os templates da WABA dele.', schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, description: 'Itens por página (1 a 200).', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        { name: 'cursor', in: 'query', required: false, description: 'Cursor opaco devolvido em `next_cursor`.', schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'Página de templates.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: ref('TemplatePage') } },
              example: { data: { items: [templateExample], next_cursor: null } },
            },
          },
        },
        '400': apiError('Filtro, `limit` ou `cursor` inválido, ou canal inexistente.', 'bad_request', "'status' inválido. Use APPROVED, PENDING, REJECTED, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION, DRAFT ou all"),
        ...common,
        '503': apiError('Catálogo indisponível no momento.', 'unavailable', 'Não foi possível consultar os templates; tente novamente'),
      },
    },
  },
  '/whatsapp/send-template': {
    post: {
      tags: ['Mensagens'],
      operationId: 'sendWhatsappTemplate',
      summary: 'Enviar um template da Meta a um número',
      description: [
        'Envia **um** template aprovado a **um** número, só em canal **Meta**. Exige `messages:send` e o header `Idempotency-Key` (obrigatório, como em `/whatsapp/send`; erros de validação **não consomem** a chave).',
        '',
        'Antes de enviar o CRM confere: número no formato E.164, template existente e **APROVADO** no catálogo da WABA do canal, nº de `variables` igual ao do corpo, componentes suportados, lista de bloqueio (opt-out) e qualidade do número (vermelha bloqueia).',
        '',
        'Canal: informe `channel` (UUID ou número do canal Meta). Sem `channel`, usa o único canal Meta ativo; havendo mais de um, a resposta é `400`.',
        '- `salvar_bd: false` envia sem gravar contato, conversa e mensagem no CRM.',
        '- Meta aceitou mas a gravação local falhou → `202` com `reconciliation_required: true`: **não reenvie**.',
        '- Falha da Meta → `502`, com `error.meta_code` e `error.meta_http_status`.',
      ].join('\n'),
      parameters: [
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description: 'Chave única por intenção de envio (8–128 caracteres).',
          schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]{8,128}$' },
          example: 'lembrete-2026-10-15-cliente-8841',
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: ref('SendTemplateRequest'),
            examples: {
              simples: {
                summary: 'Template com duas variáveis',
                value: { to: '+5527999991212', template: { name: 'lembrete_vencimento', language: 'pt_BR' }, variables: ['Ana', '150,00'], name: 'Ana Souza' },
              },
              sem_gravar: {
                summary: 'Sem gravar no CRM',
                value: { to: '+5527999991212', template: { name: 'codigo_acesso' }, variables: ['482913'], salvar_bd: false },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Template aceito pela Meta.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: ref('SendTemplateResult') } },
              example: {
                data: {
                  message_id: '5d0f0c0e-0000-4000-8000-000000000003',
                  whatsapp_message_id: 'wamid.HBgM…',
                  conversation_id: '7a1d3c50-0000-4000-8000-000000000201',
                  contact_id: 'c1d2e3f4-0000-4000-8000-000000000301',
                  channel: { id: '5b0e5a64-0000-4000-8000-000000000011', label: '+55 27 99999-1212' },
                  template: { name: 'lembrete_vencimento', language: 'pt_BR', category: 'UTILITY' },
                  status: 'accepted',
                  saved: true,
                },
              },
            },
          },
        },
        '202': {
          description: 'A Meta aceitou, mas a gravação local falhou. **Não reenvie**: a mensagem já saiu.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: ref('SendMessageReconciliation') } },
              example: { data: { success: true, saved: false, reconciliation_required: true, whatsapp_message_id: 'wamid.HBgM…', warning: 'A Meta aceitou a mensagem. Não reenvie.' } },
            },
          },
        },
        '400': apiError('Corpo inválido: telefone, template, variáveis (nº diferente do corpo), canal ou Idempotency-Key. **Não consome a chave.**', 'bad_request', "O template 'lembrete_vencimento' espera 2 variável(is) no corpo e a requisição trouxe 1"),
        '401': resp('Unauthorized'),
        '403': resp('Forbidden'),
        '409': {
          description:
            'Conflito: chave de idempotência usada com outro conteúdo (ou envio em andamento), **ou** número do canal com qualidade vermelha (`error.reason: red_quality_owner_required`; só o owner libera no painel).',
          content: {
            'application/json': {
              schema: ref('ErrorEnvelope'),
              examples: {
                outro_conteudo: { value: errorExample('conflict', 'Chave de envio já utilizada com outro conteúdo') },
                qualidade_vermelha: {
                  value: {
                    error: {
                      code: 'conflict',
                      message: 'Número com qualidade vermelha na Meta (+55 27 99999-1212): só o owner pode iniciar campanha nova nele, confirmando que está ciente.',
                      reason: 'red_quality_owner_required',
                      channels: [{ id: '5b0e5a64-0000-4000-8000-000000000011', label: '+55 27 99999-1212' }],
                    },
                  },
                },
              },
            },
          },
        },
        '422': {
          description:
            'Pedido bem formado que não pode ser atendido: canal WAHA (`unprocessable`), template inexistente, não aprovado ou com componente não suportado (`unprocessable`), ou destinatário em opt-out (`recipient_blocked`). Nada foi enviado.',
          content: {
            'application/json': {
              schema: ref('ErrorEnvelope'),
              examples: {
                waha: { value: errorExample('unprocessable', 'Template é exclusivo de canal Meta; para WAHA use /whatsapp/send com texto') },
                nao_aprovado: { value: errorExample('unprocessable', "Template 'lembrete_vencimento' não pode ser enviado: Template ainda não aprovado pela Meta (status PENDING).") },
                opt_out: { value: errorExample('recipient_blocked', 'O destinatário está na lista de bloqueio (opt-out) e não pode receber mensagens') },
              },
            },
          },
        },
        '429': resp('RateLimited'),
        '500': resp('InternalError'),
        '502': apiError('A Meta recusou ou falhou ao enviar. `error.meta_code` traz o código da Meta, quando houver.', 'internal', 'Falha no envio do template pela Meta: …', { meta_code: 132001, meta_http_status: 400 }),
        '503': apiError('Controle de envios, catálogo ou lista de bloqueio indisponível. Tente novamente com a mesma chave.', 'unavailable', 'Não foi possível verificar a lista de bloqueio; tente novamente'),
      },
    },
  },
};

export const templatesSchemas: Record<string, Json> = {
  TemplateChannel: {
    type: 'object',
    required: ['id', 'label'],
    properties: { id: { type: 'string', format: 'uuid' }, label: { type: ['string', 'null'], description: 'Número do canal.' } },
  },
  Template: {
    type: 'object',
    required: ['id', 'name', 'language', 'status', 'placeholders', 'body', 'sendable_via_api'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      language: { type: 'string', example: 'pt_BR' },
      category: { type: ['string', 'null'], enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION', null] },
      status: { type: ['string', 'null'], description: 'Situação na Meta (APPROVED, PENDING, REJECTED…).' },
      waba_id: { type: ['string', 'null'] },
      channels: { type: 'array', items: ref('TemplateChannel'), description: 'Canais Meta da conta que usam esta WABA.' },
      placeholders: {
        type: 'object',
        required: ['body', 'examples'],
        properties: {
          body: { type: 'integer', description: 'Quantas variáveis `{{n}}` o corpo exige (o envio precisa de exatamente esse nº).' },
          examples: { type: 'array', items: { type: 'string' }, description: 'Exemplos que a Meta aprovou (não são dados de clientes).' },
        },
      },
      body: { type: 'string', description: 'Texto do corpo, com `{{1}}`, `{{2}}`…' },
      header_type: { type: ['string', 'null'], description: '`text`, `image`, `video` ou `document`.' },
      buttons: { type: 'array', items: { type: 'string' }, description: 'Tipos dos botões (QUICK_REPLY, URL, PHONE_NUMBER, COPY_CODE, FLOW…).' },
      quality: { type: ['string', 'null'], enum: ['GREEN', 'YELLOW', 'RED', null] },
      sendable_via_api: { type: 'boolean', description: '`true` se `POST /whatsapp/send-template` aceita este template.' },
      unsupported_reason: { type: ['string', 'null'], description: 'Por que não pode ser enviado (quando `sendable_via_api` é `false`).' },
      updated_at: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  TemplatePage: {
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items: ref('Template') }, next_cursor: { type: ['string', 'null'], description: '`null` = fim.' } },
  },
  SendTemplateRequest: {
    type: 'object',
    required: ['template'],
    description: 'Informe `to` (ou `phone`) e `template`.',
    properties: {
      to: { type: 'string', description: 'Número em E.164 (ex.: `+5527999991212`).' },
      phone: { type: 'string', description: 'Sinônimo de `to`.' },
      template: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', example: 'lembrete_vencimento' }, language: { type: 'string', default: 'pt_BR' } },
      },
      variables: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 1024 }, description: 'Uma por `{{n}}` do corpo, na ordem. Nenhuma pode ser vazia.' },
      channel: { type: 'string', description: 'Canal Meta (UUID ou número). Sem ele, usa o único canal Meta ativo.' },
      name: { type: 'string', description: 'Nome do contato (usado só ao criar/atualizar o contato).' },
      salvar_bd: { type: 'boolean', default: true, description: '`false` = envia sem gravar contato, conversa e mensagem.' },
    },
  },
  SendTemplateResult: {
    type: 'object',
    required: ['whatsapp_message_id', 'channel', 'template', 'status', 'saved'],
    properties: {
      message_id: { type: 'string', format: 'uuid', description: 'Só com `saved: true`.' },
      whatsapp_message_id: { type: 'string' },
      conversation_id: { type: 'string', format: 'uuid', description: 'Só com `saved: true`.' },
      contact_id: { type: 'string', format: 'uuid', description: 'Só com `saved: true`.' },
      channel: ref('TemplateChannel'),
      template: {
        type: 'object',
        required: ['name', 'language'],
        properties: { name: { type: 'string' }, language: { type: 'string' }, category: { type: ['string', 'null'] } },
      },
      status: { type: 'string', enum: ['accepted'] },
      saved: { type: 'boolean' },
    },
  },
};
