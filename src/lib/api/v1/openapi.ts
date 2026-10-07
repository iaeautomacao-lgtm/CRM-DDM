// ============================================================
// Especificação OpenAPI 3.1 da API pública (/api/v1) — fonte única da
// documentação navegável (GET /api/v1/openapi.json e a página
// Configurações → API keys → "Ver documentação da API").
//
// Regra: toda rota nova em src/app/api/v1/**/route.ts precisa de entrada
// aqui; o teste openapi.test.ts falha se faltar.
//
// Não contém segredo nenhum (só descrição de contrato).
// ============================================================

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });

/** Corpo de erro do envelope `{ error: { code, message } }`. */
function errorExample(code: string, message: string): Json {
  return { error: { code, message } };
}

const SECURITY = [{ bearerAuth: [] }];

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'API pública do CRM DDM',
    version: '1.0.0',
    summary: 'Envio de mensagens e campanhas do Disparador por integração.',
    description: [
      'A API pública permite integrar sistemas (ex.: planejamento de cobrança) ao CRM DDM sem usar o dashboard.',
      '',
      '## Autenticação',
      'Toda requisição usa uma **chave de API** como token Bearer: `Authorization: Bearer wacrm_live_…`.',
      'Crie a chave em **Configurações → API keys** (somente owner/admin). A chave é **da conta**: age apenas na conta em que foi criada. O valor completo aparece **uma única vez**; só o hash SHA-256 fica guardado.',
      '',
      '## Escopos',
      'Cada chave carrega os escopos concedidos na criação. Conceda o mínimo necessário:',
      '- `messages:send` — `POST /whatsapp/send`',
      '- `campaigns:write` — `POST /disparador/campaigns` (também lê campanhas)',
      '- `campaigns:read` — `GET /disparador/campaigns/{id}`',
      '- `GET /me` não exige escopo.',
      '',
      '## Envelope de resposta',
      'Sucesso: `{ "data": … }`. Falha: `{ "error": { "code": "…", "message": "…" } }`. Ramifique pelo `code` (estável); a `message` é para humanos e pode mudar.',
      '',
      '## Limite de requisições',
      '**120 requisições por minuto por chave.** Ao exceder: `429` com `Retry-After` (segundos) e `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.',
      '',
      '## Idempotência',
      '- `POST /whatsapp/send`: o header `Idempotency-Key` é **obrigatório**. Erros 400 de validação (antes de chamar o provedor) **não consomem** a chave: corrija e reenvie com a mesma chave.',
      '- `POST /disparador/campaigns`: `Idempotency-Key` (header) ou `external_id` (corpo) são **opcionais**; sem eles cada chamada cria uma campanha nova.',
      '',
      '## Fuso e janela de envio',
      'Horários de janela (`janela_inicio`/`janela_fim`) são de **Brasília** (UTC-3).',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1', description: 'CRM DDM (a rota /api/v1/openapi.json usa NEXT_PUBLIC_APP_URL)' }],
  tags: [
    { name: 'Conta', description: 'Identidade da chave.' },
    { name: 'Mensagens', description: 'Envio avulso de mensagens WhatsApp.' },
    { name: 'Disparador', description: 'Campanhas em massa (Meta com template, WAHA com texto livre).' },
  ],
  security: SECURITY,
  paths: {
    '/me': {
      get: {
        tags: ['Conta'],
        operationId: 'getMe',
        summary: 'Identidade da chave',
        description:
          'Devolve a conta à qual a chave pertence e os escopos que ela carrega. Não exige escopo — use para verificar se a chave funciona.',
        responses: {
          '200': {
            description: 'Conta e escopos da chave.',
            headers: { 'X-RateLimit-Limit': { $ref: '#/components/headers/X-RateLimit-Limit' } },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: {
                    data: {
                      type: 'object',
                      required: ['account', 'key'],
                      properties: {
                        account: {
                          type: 'object',
                          properties: { id: { type: 'string', format: 'uuid' }, name: { type: ['string', 'null'] } },
                        },
                        key: {
                          type: 'object',
                          properties: {
                            id: { type: 'string', format: 'uuid' },
                            scopes: { type: 'array', items: ref('Scope') },
                          },
                        },
                      },
                    },
                  },
                },
                example: {
                  data: {
                    account: { id: '3f6c1c1e-0000-4000-8000-000000000001', name: 'DDM Cobrança' },
                    key: { id: '9a1b2c3d-0000-4000-8000-000000000002', scopes: ['messages:send', 'campaigns:write'] },
                  },
                },
              },
            },
          },
          '401': resp('Unauthorized'),
          '429': resp('RateLimited'),
          '500': resp('InternalError'),
        },
      },
    },

    '/whatsapp/send': {
      post: {
        tags: ['Mensagens'],
        operationId: 'sendWhatsappMessage',
        summary: 'Enviar mensagem avulsa',
        description: [
          'Envia texto e/ou mídia pelo canal WhatsApp habilitado da conta (WAHA ou Meta). Encontra ou cria o contato e a conversa, a menos que `salvar_bd` seja `false`.',
          '',
          'Exige o escopo `messages:send` e o header **`Idempotency-Key`** (8–128 caracteres: letras, números, `.`, `_`, `:`, `-`). Uma chave por intenção de envio; repita **a mesma chave e o mesmo corpo** ao reenviar.',
          '',
          '- Chave repetida com o mesmo conteúdo e envio concluído → devolve a resposta original, sem novo envio.',
          '- Chave repetida com outro conteúdo → `409 conflict`.',
          '- Envio em andamento ou com resultado desconhecido (o provedor pode ter aceitado) → `409 conflict` com `provider_outcome_unknown: true`. **Não reenvie com outra chave**; aguarde a reconciliação.',
          '- Erros `400` de validação acontecem antes de chamar o provedor e **não consomem** a chave.',
          '- Destinatário na blacklist/opt-out → `422 recipient_blocked`, sem chamar o provedor.',
          '- Provedor aceitou mas a gravação local falhou → `202` com `reconciliation_required: true`: **não reenvie**.',
          '',
          'Observação: este endpoint envia texto/mídia livres. Fora da janela de 24h da Meta, a Meta recusa texto livre (erro do provedor, `502`).',
        ].join('\n'),
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            description: 'Chave única por intenção de envio (8–128 caracteres).',
            schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]{8,128}$' },
            example: 'cobranca-2026-10-07-cliente-8841',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('SendMessageRequest'),
              examples: {
                texto: {
                  summary: 'Texto simples',
                  value: {
                    phone: '+5527999991212',
                    text: 'Olá, Ana! Identificamos uma pendência de R$ 150,00 vencida em 05/10. Podemos ajudar?',
                    name: 'Ana Souza',
                  },
                },
                midia_url: {
                  summary: 'Boleto em PDF por URL',
                  value: {
                    phone: '+5527999991212',
                    media_url: 'https://exemplo.com.br/boletos/8841.pdf',
                    media_type: 'application/pdf',
                    media_caption: 'Segue o boleto atualizado.',
                  },
                },
                sem_gravar: {
                  summary: 'Notificação transacional sem gravar no CRM',
                  value: { phone: '+5527999991212', text: 'Seu acordo foi confirmado.', salvar_bd: false },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Mensagem aceita pelo provedor.',
            headers: { 'X-RateLimit-Limit': { $ref: '#/components/headers/X-RateLimit-Limit' } },
            content: {
              'application/json': {
                schema: { type: 'object', required: ['data'], properties: { data: ref('SendMessageResult') } },
                example: {
                  data: { success: true, saved: true, message_id: '5d0f0c0e-0000-4000-8000-000000000003', whatsapp_message_id: 'wamid.HBgM…' },
                },
              },
            },
          },
          '202': {
            description:
              'O provedor aceitou a mensagem, mas a gravação local falhou. **Não reenvie**: a mensagem já saiu.',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['data'], properties: { data: ref('SendMessageReconciliation') } },
                example: {
                  data: {
                    success: true,
                    saved: false,
                    reconciliation_required: true,
                    whatsapp_message_id: 'wamid.HBgM…',
                    warning: 'Provider accepted the message. Do not resend.',
                  },
                },
              },
            },
          },
          '400': {
            description:
              'Entrada inválida (telefone, texto/mídia ausente, mídia inválida, JSON inválido, Idempotency-Key ausente/malformada, nenhum canal configurado). **Não consome a Idempotency-Key.**',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                examples: {
                  telefone: { value: errorExample('bad_request', 'Invalid phone number format. Must be in E.164 format (ex: +5527999991212)') },
                  chave: { value: errorExample('bad_request', 'Informe uma chave Idempotency-Key por intenção de envio') },
                },
              },
            },
          },
          '401': resp('Unauthorized'),
          '403': resp('Forbidden'),
          '409': {
            description:
              'Conflito de idempotência: chave usada com outro conteúdo, ou envio em andamento/resultado desconhecido (`provider_outcome_unknown`). Não reenvie com outra chave.',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                examples: {
                  outro_conteudo: { value: errorExample('conflict', 'Chave de envio já utilizada com outro conteúdo') },
                  desconhecido: {
                    value: {
                      error: {
                        code: 'conflict',
                        message: 'Envio em andamento ou com resultado desconhecido. Não reenvie; aguarde reconciliação.',
                        provider_outcome_unknown: true,
                      },
                    },
                  },
                },
              },
            },
          },
          '422': {
            description: 'Destinatário na blacklist/opt-out: nada foi enviado ao provedor.',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                example: errorExample('recipient_blocked', 'O destinatário está na lista de bloqueio (opt-out) e não pode receber mensagens'),
              },
            },
          },
          '429': resp('RateLimited'),
          '500': resp('InternalError'),
          '502': {
            description:
              'O provedor (Meta/WAHA) recusou ou falhou ao enviar. O resultado é conhecido (não enviado): a chave de idempotência continua reservada; gere uma nova chave para tentar de novo após corrigir a causa.',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                example: errorExample('internal', 'WhatsApp sending failed: …'),
              },
            },
          },
          '503': {
            description: 'Controle de idempotência indisponível. Tente novamente com a mesma chave.',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                example: errorExample('unavailable', 'Controle de envios indisponível'),
              },
            },
          },
        },
      },
    },

    '/disparador/campaigns': {
      post: {
        tags: ['Disparador'],
        operationId: 'createCampaign',
        summary: 'Criar e enfileirar campanha',
        description: [
          'Cria uma campanha do Disparador e a coloca na fila imediatamente (status `em_execucao`; não há rascunho/revisão por esta rota). Exige `campaigns:write`.',
          '',
          '**Canal.** `channel` aceita o UUID do canal ou o número de telefone de um canal **Meta**. Omita apenas se a conta tiver exatamente um canal habilitado. Canais **WAHA** só por UUID.',
          '',
          '**Meta × WAHA.** Canal **Meta**: `template_name` obrigatório (template **aprovado** na WABA do canal); `variables` de cada contato vão como parâmetros do template. Canal **WAHA**: `message` obrigatório, texto livre com `{{1}}`, `{{2}}`… preenchidos com as `variables` do contato.',
          '',
          '**Validação e deduplicação (antes de enfileirar).**',
          '- `duplicates`: mesmo número repetido (com/sem `+55`, com/sem o 9º dígito) — o primeiro vale.',
          '- `skipped`: números na blacklist.',
          '- `invalid`: contato que não é objeto, sem telefone, telefone inválido (7–15 dígitos; números `55` precisam de 12–13) ou, no WAHA, `{{n}}` sem valor (`missing_variable`). `invalid_sample` lista até 20, com `index`, `phone` e `reason`.',
          '- Se nenhum contato válido restar: `400` com os mesmos contadores.',
          '',
          '**Limites.** Até **20.000 contatos por requisição** e corpo de até 15 MB (acima: `413 payload_too_large` — divida em várias campanhas).',
          '',
          '**Agenda.** O envio só acontece dentro da janela (`janela_inicio`–`janela_fim`, Brasília) e dos dias permitidos (`dias_envio`, padrão segunda a sexta). Cada slot de `slot_size` contatos sai `slot_interval_minutes` de tempo **aberto da janela** depois do anterior: uma campanha criada às 20:00 com janela 08:00–18:00 começa às 08:00 do próximo dia permitido, sem rajada.',
          '',
          '**Idempotência (opcional).** Envie `Idempotency-Key` (header) **ou** `external_id` (corpo; vence se ambos vierem). Repetir com o mesmo conteúdo devolve a campanha existente (`200`, mesmo corpo da criação); mesma chave com outro conteúdo → `409 conflict`; repetição enquanto a primeira criação ainda roda → `409`. Sem nenhum dos dois, cada chamada cria uma campanha.',
          '',
          '**Falha no meio.** Se o enfileiramento falhar, os itens já inseridos são removidos, a campanha é encerrada (`encerrada`), a chave é liberada e a resposta é `500` com `error.campaign_id` — repetir é seguro.',
        ].join('\n'),
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description: 'Opcional. Torna a criação idempotente (8–128 caracteres). Alternativa: `external_id` no corpo.',
            schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]{8,128}$' },
            example: 'planejamento-2026-10-07-lote-3',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('CreateCampaignRequest'),
              examples: {
                meta_template: {
                  summary: 'Canal Meta com template aprovado',
                  value: {
                    campaign_name: 'Cobrança outubro — lote 3',
                    external_id: 'PLAN-2026-10-LOTE-3',
                    channel: '+55 21 3030-9159',
                    template_name: 'cobranca_vencida',
                    template_language: 'pt_BR',
                    janela_inicio: '08:00',
                    janela_fim: '18:00',
                    contacts: [
                      { phone: '+5527999991212', variables: ['Ana', 'R$ 150,00', '05/10'] },
                      { phone: '+5511988887777', variables: ['Bruno', 'R$ 89,90', '03/10'] },
                    ],
                  },
                },
                waha_texto: {
                  summary: 'Canal WAHA com texto livre',
                  value: {
                    campaign_name: 'Lembrete de acordo',
                    channel: '2f0a4c9e-0000-4000-8000-000000000010',
                    message: 'Olá, {{1}}! Sua parcela de {{2}} vence em {{3}}.',
                    dias_envio: [1, 2, 3, 4, 5],
                    contacts: [{ phone: '27999991212', variables: ['Ana', 'R$ 150,00', '10/10'] }],
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Repetição idempotente: devolve a campanha já criada (mesmo corpo da criação).',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['data'], properties: { data: ref('CreateCampaignResult') } },
              },
            },
          },
          '201': {
            description: 'Campanha criada e enfileirada.',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['data'], properties: { data: ref('CreateCampaignResult') } },
                example: {
                  data: {
                    campaign_id: '7c9e6679-0000-4000-8000-000000000020',
                    enqueued: 1,
                    skipped: 0,
                    duplicates: 1,
                    invalid: 1,
                    invalid_sample: [{ index: 3, phone: 'abc', reason: 'missing_phone' }],
                    slots: 1,
                    slot_size: 1000,
                    slot_interval_minutes: 30,
                    estimated_completion_minutes: 0,
                  },
                },
              },
            },
          },
          '400': {
            description:
              'Entrada inválida: nome ausente/longo, `contacts` vazio, canal não encontrado/desabilitado, template ausente/não aprovado (Meta), `message` ausente (WAHA), janela ou `dias_envio` inválidos, `external_id`/`Idempotency-Key` malformados, JSON inválido, `callback_url` insegura ou nenhum contato válido.',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                examples: {
                  janela: { value: errorExample('bad_request', "'janela_fim' deve ser depois de 'janela_inicio' (o envio acontece dentro do mesmo dia)") },
                  sem_validos: {
                    value: {
                      error: {
                        code: 'bad_request',
                        message: 'Nenhum contato válido para enfileirar',
                        invalid: 2,
                        duplicates: 0,
                        skipped: 0,
                        invalid_sample: [{ index: 0, phone: 'x', reason: 'invalid_phone' }],
                      },
                    },
                  },
                },
              },
            },
          },
          '401': resp('Unauthorized'),
          '403': resp('Forbidden'),
          '409': {
            description:
              'Conflito de idempotência: `Idempotency-Key`/`external_id` já usado com outro conteúdo, ou a criação anterior com a mesma chave ainda está em andamento.',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                example: errorExample('conflict', 'Chave de idempotência/external_id já utilizada com outro conteúdo'),
              },
            },
          },
          '413': {
            description: 'Mais de 20.000 contatos ou corpo acima de 15 MB. Divida em várias campanhas.',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                example: errorExample(
                  'payload_too_large',
                  'Máximo de 20000 contatos por requisição (recebido: 25000); divida em várias campanhas'
                ),
              },
            },
          },
          '429': resp('RateLimited'),
          '500': {
            description:
              'Erro interno. Se vier `error.campaign_id`, o enfileiramento falhou no meio, a fila foi desfeita e a campanha foi encerrada; repetir a requisição é seguro.',
            content: {
              'application/json': {
                schema: ref('ErrorEnvelope'),
                examples: {
                  generico: { value: errorExample('internal', 'Internal server error') },
                  rollback: {
                    value: {
                      error: {
                        code: 'internal',
                        message: 'Falha ao enfileirar a campanha; ela foi cancelada. Pode repetir a requisição.',
                        campaign_id: '7c9e6679-0000-4000-8000-000000000020',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/disparador/campaigns/{id}': {
      get: {
        tags: ['Disparador'],
        operationId: 'getCampaign',
        summary: 'Status e métricas de uma campanha',
        description:
          'Exige `campaigns:read` **ou** `campaigns:write`. Só enxerga campanhas da própria conta: de outra conta (ou id inexistente) devolve `404`, nunca `403`.',
        parameters: [
          { name: 'id', in: 'path', required: true, description: 'ID da campanha (`campaign_id`).', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Status, janela, métricas e contagem da fila.',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['data'], properties: { data: ref('Campaign') } },
                example: {
                  data: {
                    campaign_id: '7c9e6679-0000-4000-8000-000000000020',
                    name: 'Cobrança outubro — lote 3',
                    status: 'em_execucao',
                    created_at: '2026-10-07T13:17:05.616Z',
                    window: { start: '08:00:00', end: '18:00:00' },
                    metrics: { total_contacts: 1000, sent: 450, delivered: 440, read: 200, errors: 10, pending: 550 },
                    queue: { agendado: 550, enviando: 0, entregue: 440, erro: 10, cancelado: 0 },
                  },
                },
              },
            },
          },
          '401': resp('Unauthorized'),
          '403': resp('Forbidden'),
          '404': {
            description: 'Campanha inexistente ou de outra conta.',
            content: {
              'application/json': { schema: ref('ErrorEnvelope'), example: errorExample('not_found', 'Campanha não encontrada') },
            },
          },
          '429': resp('RateLimited'),
          '500': resp('InternalError'),
        },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'wacrm_live_…',
        description: 'Chave de API da conta: `Authorization: Bearer wacrm_live_…`.',
      },
    },
    headers: {
      'X-RateLimit-Limit': { description: 'Requisições permitidas por janela de 1 minuto (120).', schema: { type: 'integer' } },
      'X-RateLimit-Remaining': { description: 'Requisições restantes na janela atual.', schema: { type: 'integer' } },
      'X-RateLimit-Reset': { description: 'Instante (epoch, segundos) em que a janela reinicia.', schema: { type: 'integer' } },
      'Retry-After': { description: 'Segundos até poder tentar de novo.', schema: { type: 'integer' } },
    },
    responses: {
      Unauthorized: {
        description: 'Chave ausente, malformada, desconhecida, revogada ou expirada (indistinguíveis de propósito).',
        content: {
          'application/json': {
            schema: ref('ErrorEnvelope'),
            example: errorExample('unauthorized', 'Missing or invalid API key'),
          },
        },
      },
      Forbidden: {
        description: 'Chave válida, mas sem o escopo exigido pela rota.',
        content: {
          'application/json': {
            schema: ref('ErrorEnvelope'),
            example: errorExample('forbidden', 'This API key is missing one of the required scopes: messages:send'),
          },
        },
      },
      RateLimited: {
        description: 'Limite de 120 requisições por minuto por chave excedido.',
        headers: {
          'Retry-After': { $ref: '#/components/headers/Retry-After' },
          'X-RateLimit-Limit': { $ref: '#/components/headers/X-RateLimit-Limit' },
          'X-RateLimit-Remaining': { $ref: '#/components/headers/X-RateLimit-Remaining' },
          'X-RateLimit-Reset': { $ref: '#/components/headers/X-RateLimit-Reset' },
        },
        content: {
          'application/json': {
            schema: ref('ErrorEnvelope'),
            example: errorExample('rate_limited', 'Rate limit exceeded for this API key'),
          },
        },
      },
      InternalError: {
        description: 'Erro interno (a mensagem é genérica; detalhes ficam só no servidor).',
        content: {
          'application/json': {
            schema: ref('ErrorEnvelope'),
            example: errorExample('internal', 'Internal server error'),
          },
        },
      },
    },
    schemas: {
      Scope: {
        type: 'string',
        enum: [
          'messages:send',
          'messages:read',
          'contacts:read',
          'contacts:write',
          'conversations:read',
          'campaigns:write',
          'campaigns:read',
          'intelligence:read',
        ],
        description: '`intelligence:read` é de chave **pessoal** (MCP do DDM Intelligence) e não se combina com os demais.',
      },
      ErrorCode: {
        type: 'string',
        enum: [
          'unauthorized',
          'forbidden',
          'rate_limited',
          'bad_request',
          'not_found',
          'conflict',
          'payload_too_large',
          'recipient_blocked',
          'unavailable',
          'internal',
        ],
        description:
          '`unauthorized` 401 · `forbidden` 403 · `rate_limited` 429 · `bad_request` 400 · `not_found` 404 · `conflict` 409 · `payload_too_large` 413 · `recipient_blocked` 422 · `unavailable` 503 · `internal` 500/502.',
      },
      ErrorEnvelope: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            additionalProperties: true,
            properties: {
              code: ref('ErrorCode'),
              message: { type: 'string', description: 'Texto para humanos; pode mudar. Ramifique pelo `code`.' },
              campaign_id: { type: 'string', format: 'uuid', description: 'Só em 500 de criação de campanha interrompida.' },
              provider_outcome_unknown: { type: 'boolean', description: 'Só em 409 de envio com resultado desconhecido.' },
              invalid: { type: 'integer', description: 'Só em 400 "nenhum contato válido".' },
              duplicates: { type: 'integer' },
              skipped: { type: 'integer' },
              invalid_sample: { type: 'array', items: ref('InvalidContactSample') },
            },
          },
        },
      },
      SendMessageRequest: {
        type: 'object',
        description: 'Informe `phone` (ou `to`) e `text` (ou `message`) — ou uma mídia. `media_url` e `media_base64` são mutuamente exclusivos.',
        properties: {
          phone: { type: 'string', description: 'Telefone em E.164 (com ou sem `+`). Alias: `to`.', example: '+5527999991212' },
          to: { type: 'string', description: 'Alias de `phone`.' },
          text: { type: 'string', description: 'Texto. Alias: `message`. Obrigatório se não houver mídia; vira legenda de imagem/vídeo se não houver `media_caption`.' },
          message: { type: 'string', description: 'Alias de `text`.' },
          name: { type: 'string', description: 'Nome do contato (aplicado ao criar ou renomear).' },
          media_url: { type: 'string', format: 'uri', pattern: '^https://', description: 'URL pública `https://` da mídia (o provedor baixa direto).' },
          media_base64: { type: 'string', description: 'Base64 puro, sem prefixo `data:`. Máx. 16 MB decodificado. Exige `media_type`.' },
          media_type: {
            type: 'string',
            enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'audio/ogg', 'audio/mpeg', 'application/pdf'],
          },
          media_caption: { type: 'string', maxLength: 1024, description: 'Legenda; só vale para imagem/vídeo.' },
          salvar_bd: { type: 'boolean', default: true, description: '`false` = não grava contato/conversa/mensagem no CRM (envio transacional).' },
        },
      },
      SendMessageResult: {
        type: 'object',
        required: ['success', 'saved', 'whatsapp_message_id'],
        properties: {
          success: { type: 'boolean' },
          saved: { type: 'boolean', description: '`false` quando `salvar_bd` é `false`.' },
          message_id: { type: 'string', format: 'uuid', description: 'ID da mensagem no CRM (só com `saved: true`).' },
          whatsapp_message_id: { type: 'string', description: 'ID da mensagem no provedor (`wamid…`).' },
          media_id: { type: ['string', 'null'], description: 'ID da mídia enviada à Meta (apenas `media_base64` em canal Meta).' },
        },
      },
      SendMessageReconciliation: {
        type: 'object',
        required: ['success', 'saved', 'reconciliation_required', 'whatsapp_message_id'],
        properties: {
          success: { type: 'boolean', const: true },
          saved: { type: 'boolean', const: false },
          reconciliation_required: { type: 'boolean', const: true },
          whatsapp_message_id: { type: 'string' },
          warning: { type: 'string' },
        },
      },
      CampaignContact: {
        type: 'object',
        required: ['phone'],
        properties: {
          phone: { type: 'string', description: 'Telefone com ou sem `+` (7–15 dígitos; números `55` com 12–13).' },
          variables: {
            type: 'array',
            items: { type: 'string' },
            description: 'Variáveis posicionais `{{1}}`, `{{2}}`… (Meta: parâmetros do template; WAHA: substituídas no texto).',
          },
        },
      },
      CreateCampaignRequest: {
        type: 'object',
        required: ['campaign_name', 'contacts'],
        properties: {
          campaign_name: { type: 'string', maxLength: 120 },
          external_id: {
            type: 'string',
            maxLength: 128,
            pattern: '^[A-Za-z0-9._:\\-/]{1,128}$',
            description: 'Id do seu sistema. Torna a criação idempotente (vence o header `Idempotency-Key`).',
          },
          channel: { type: 'string', description: 'UUID do canal ou número de um canal Meta. Omita só se houver um único canal habilitado.' },
          template_name: { type: 'string', description: '**Meta**: obrigatório; template aprovado na WABA do canal.' },
          template_language: { type: 'string', default: 'pt_BR' },
          message: { type: 'string', description: '**WAHA**: obrigatório; texto livre com `{{1}}`, `{{2}}`…' },
          contacts: {
            type: 'array',
            minItems: 1,
            maxItems: 20000,
            items: ref('CampaignContact'),
            description: 'Contatos externos (não precisam existir no CRM). Máx. 20.000 por requisição.',
          },
          slot_size: { type: 'integer', minimum: 1, default: 1000, description: 'Contatos por slot.' },
          slot_interval_minutes: { type: 'number', minimum: 1, default: 30, description: 'Minutos de janela aberta entre slots.' },
          janela_inicio: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', default: '08:00', description: 'HH:MM (Brasília).' },
          janela_fim: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', default: '18:00', description: 'HH:MM (Brasília); depois de `janela_inicio`.' },
          dias_envio: {
            type: 'array',
            items: { type: 'integer', minimum: 0, maximum: 6 },
            default: [1, 2, 3, 4, 5],
            description: 'Dias permitidos (0 = domingo … 6 = sábado). Padrão: dias úteis.',
          },
          objective: { type: 'string' },
          callback_url: {
            type: 'string',
            format: 'uri',
            description: 'Chamada pelo servidor ao final da campanha. Rejeitada se resolver para endereço interno/privado.',
          },
        },
      },
      InvalidContactSample: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Posição do contato em `contacts` (0-based).' },
          phone: { type: ['string', 'null'] },
          reason: { type: 'string', enum: ['invalid_contact', 'missing_phone', 'invalid_phone', 'missing_variable'] },
        },
      },
      CreateCampaignResult: {
        type: 'object',
        required: ['campaign_id', 'enqueued', 'skipped', 'duplicates', 'invalid'],
        properties: {
          campaign_id: { type: 'string', format: 'uuid' },
          enqueued: { type: 'integer', description: 'Contatos enfileirados.' },
          skipped: { type: 'integer', description: 'Na blacklist.' },
          duplicates: { type: 'integer', description: 'Repetidos no payload (phoneKey).' },
          invalid: { type: 'integer', description: 'Rejeitados pela validação.' },
          invalid_sample: { type: 'array', maxItems: 20, items: ref('InvalidContactSample') },
          slots: { type: 'integer' },
          slot_size: { type: 'integer' },
          slot_interval_minutes: { type: 'number' },
          estimated_completion_minutes: { type: 'number', description: 'Tempo de janela aberta até o último slot começar.' },
        },
      },
      Campaign: {
        type: 'object',
        properties: {
          campaign_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          status: { type: 'string', description: 'Ex.: `rascunho`, `em_execucao`, `pausada`, `encerrada`.' },
          created_at: { type: 'string', format: 'date-time' },
          window: {
            type: 'object',
            properties: { start: { type: ['string', 'null'] }, end: { type: ['string', 'null'] } },
          },
          metrics: {
            type: 'object',
            properties: {
              total_contacts: { type: 'integer' },
              sent: { type: 'integer' },
              delivered: { type: 'integer' },
              read: { type: 'integer' },
              errors: { type: 'integer' },
              pending: { type: 'integer', description: 'Igual a `queue.agendado`.' },
            },
          },
          queue: {
            type: 'object',
            description: 'Contagem por status da fila (somente os listados).',
            properties: {
              agendado: { type: 'integer' },
              enviando: { type: 'integer' },
              entregue: { type: 'integer' },
              erro: { type: 'integer' },
              cancelado: { type: 'integer' },
            },
          },
        },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openApiSpec;

/** Spec com o servidor trocado pela URL do CRM (NEXT_PUBLIC_APP_URL), se houver. */
export function buildOpenApiSpec(appUrl?: string | null): Json {
  const base = (appUrl ?? '').trim().replace(/\/+$/, '');
  const spec = JSON.parse(JSON.stringify(openApiSpec)) as Json;
  if (base) {
    spec.servers = [{ url: `${base}/api/v1`, description: 'CRM DDM' }];
  } else {
    spec.servers = [{ url: '/api/v1', description: 'CRM DDM (mesmo host desta página)' }];
  }
  return spec;
}
