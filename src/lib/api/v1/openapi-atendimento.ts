// OpenAPI do CONTROLE do atendimento (Onda 2): POST /conversations, POST /conversations/{id}/close e POST /conversations/{id}/transfer.
// Mesclado em openapi.ts (o POST /conversations entra no mesmo caminho do GET de extração). Sem segredo: só contrato.

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const apiError = (description: string, code: string, message: string, extra: Json = {}) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: { error: { code, message, ...extra } } } },
});
const unavailable = apiError('Banco ou controle de envios indisponível. Tente de novo.', 'unavailable', 'Não foi possível abrir a conversa; tente novamente');
const idParam = { name: 'id', in: 'path', required: true, description: 'ID da conversa.', schema: { type: 'string', format: 'uuid' } };

export const ATENDIMENTO_GUIDE = [
  '',
  '### Abrir, encerrar e transferir (escopo `conversations:write`)',
  '- `POST /conversations` abre o atendimento de um contato (`phone` ou `contact_id`) num canal, com `assignee_id` (em atendimento) **ou** `team_id` (fila da equipe). Se já existe atendimento aberto do contato no canal, devolve esse (`created: false`); se foi pedido outro atendente/equipe, responde `409` (`error.reason = conversation_exists`) a menos que venha `force_transfer: true`. A **mensagem inicial** é opcional: `message.template` (Meta) ou `message.text` (na Meta só dentro de 24h da última mensagem do cliente; no WAHA sempre). Com mensagem, o header `Idempotency-Key` é **obrigatório**. **Escopos extras:** enviar `message` exige também `messages:send`, e criar o contato pelo `phone` (que ainda não existe) exige também `contacts:write`.',
  '- `POST /conversations/{id}/close` encerra com `tabulation_code` (ou `tabulation_id`; veja `GET /tabulations`) e `note` opcional (vira nota do contato, nunca vai ao cliente). Dispara os eventos de sempre (`conversation.closed`, e `agreement.created` na tabulação 142). Repetir é seguro: mesma tabulação = `changed: false`.',
  '- `POST /conversations/{id}/transfer` troca atendente e/ou equipe (`null` remove). **Atendente em pausa**: `409` com `error.reason = agent_paused` (traz `agent` e `pause`); repita com `confirm_paused: true` para atribuir mesmo assim. A atribuição automática nunca escolhe quem está em pausa.',
  '- Limite: **30 requisições por minuto por chave** nestas três rotas (além dos 120/min gerais).',
].join('\n');

const conversationExample = {
  id: '7a1d3c50-0000-4000-8000-000000000201',
  status: 'open',
  assignee_id: '5b0e5a64-0000-4000-8000-000000000032',
  team_id: '5b0e5a64-0000-4000-8000-000000000031',
  contact_id: 'c1d2e3f4-0000-4000-8000-000000000301',
  channel: { id: '5b0e5a64-0000-4000-8000-000000000011', waha_session: null },
};

const single = (description: string, schema: string, example: Json) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: ref(schema) } }, example: { data: example } } },
});

export const conversationsPost: Json = {
  tags: ['Atendimento'],
  operationId: 'openConversation',
  summary: 'Abrir (ou reaproveitar) um atendimento',
  description: [
    'Abre o atendimento de um contato num canal e, se quiser, já envia a primeira mensagem. Exige `conversations:write`.',
    '',
    '- **Escopos adicionais:** com `message` a chave também precisa de `messages:send` (senão `403`, nada é enviado nem registrado). Se o `phone` ainda não é contato e a chamada o criaria, a chave também precisa de `contacts:write` (senão `403`); com `contact_id` ou telefone já cadastrado basta `conversations:write`.',
    '- **Sem duplicar:** chamadas simultâneas para o mesmo contato e canal devolvem o MESMO atendimento (a segunda recebe `created: false`).',
    '- **Quem atende:** `assignee_id` = conversa `open` desse atendente; só `team_id` = conversa `pending` na fila da equipe; nenhum dos dois = o **dono do contato** (carteira fixa, se ativo e fora de pausa; `via_owner: true`) ou, sem dono, a fila da conta.',
    '- **Já existe atendimento aberto** do contato neste canal: devolve ele (`created: false`). Pediu outro atendente/equipe? `409` (`error.reason = conversation_exists`, com a conversa atual) — ou transfira na hora com `force_transfer: true`.',
    '- **Mensagem inicial:** `message.template` (só canal Meta; mesmas regras de `POST /whatsapp/send-template`) ou `message.text` (Meta: só dentro de 24h da última mensagem do cliente, senão `422` `window_closed`; WAHA: sempre). Contato na lista de bloqueio = `422`. Com mensagem, `Idempotency-Key` é obrigatório.',
    '- **Pausa:** atendente em pausa = `409` (`error.reason = agent_paused`); repita com `confirm_paused: true`.',
  ].join('\n'),
  parameters: [
    { name: 'Idempotency-Key', in: 'header', required: false, description: 'Obrigatória quando há `message` (8–128 caracteres). Sem mensagem o pedido já é idempotente.', schema: { type: 'string', minLength: 8, maxLength: 128 } },
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: ref('OpenConversationRequest'),
        examples: {
          com_template: {
            summary: 'Abrir para um operador, com template',
            value: { phone: '+5527999991212', channel: '+55 27 99999-1212', assignee_id: '5b0e5a64-0000-4000-8000-000000000032', message: { template: { name: 'lembrete_vencimento', language: 'pt_BR', variables: ['Ana', '150,00'] } } },
          },
          fila_equipe: { summary: 'Só colocar na fila da equipe', value: { phone: '+5527999991212', team_id: '5b0e5a64-0000-4000-8000-000000000031' } },
        },
      },
    },
  },
  responses: {
    '200': single('Já existia atendimento aberto (ou foi transferido com `force_transfer`).', 'OpenConversationResult', { conversation: { ...conversationExample, created: false }, transferred: false }),
    '201': single('Atendimento aberto.', 'OpenConversationResult', {
      conversation: { ...conversationExample, created: true },
      transferred: false,
      message: { id: '5d0f0c0e-0000-4000-8000-000000000003', whatsapp_message_id: 'wamid.HBgM…', kind: 'template', saved: true },
    }),
    '400': apiError('Corpo inválido: telefone, canal, atendente/equipe, mensagem ou `Idempotency-Key` (obrigatória com mensagem).', 'bad_request', "Informe 'phone' (E.164) ou 'contact_id'"),
    '401': resp('Unauthorized'),
    '403': resp('Forbidden'),
    '404': apiError('Contato, atendente ou equipe inexistente (ou de outra conta).', 'not_found', 'Atendente não encontrado'),
    '409': {
      description:
        'Conflito: atendente em pausa (`error.reason = agent_paused`, com `agent` e `pause`), atendimento já aberto com outro atendente/equipe (`conversation_exists`), número em qualidade vermelha (`red_quality_owner_required`) ou `Idempotency-Key` reutilizada com outro conteúdo.',
      content: {
        'application/json': {
          schema: ref('ErrorEnvelope'),
          examples: {
            em_pausa: { value: { error: { code: 'conflict', message: "Ana Souza está em pausa. Repita com 'confirm_paused': true para atribuir mesmo assim.", reason: 'agent_paused', agent: { id: '5b0e5a64-0000-4000-8000-000000000032', name: 'Ana Souza' }, pause: { reason: 'Almoço', since: '2026-10-15T15:00:00.000Z' } } } },
            ja_aberto: { value: { error: { code: 'conflict', message: 'Já existe um atendimento aberto deste contato neste canal com outro atendente/equipe. Use force_transfer: true para transferir.', reason: 'conversation_exists', conversation: conversationExample } } },
          },
        },
      },
    },
    '422': apiError('Destinatário em opt-out (`recipient_blocked`), janela de 24h fechada (`reason: window_closed`), template inexistente/não aprovado/em canal WAHA (`unprocessable`).', 'unprocessable', 'A janela de 24h da Meta está fechada: envie um template em message.template.', { reason: 'window_closed' }),
    '429': resp('RateLimited'),
    '500': resp('InternalError'),
    '502': apiError('A Meta ou o WAHA recusou o envio da mensagem inicial (`error.meta_code` quando for da Meta). A conversa já foi aberta.', 'internal', 'Falha no envio pela Meta: …', { meta_code: 132001, meta_http_status: 400 }),
    '503': unavailable,
  },
};

export const atendimentoPaths: Record<string, Json> = {
  '/conversations/{id}/close': {
    post: {
      tags: ['Atendimento'],
      operationId: 'closeConversation',
      summary: 'Encerrar uma conversa com tabulação',
      description:
        'Encerra a conversa com a tabulação indicada (`tabulation_code`, o código do `GET /tabulations`, ou `tabulation_id`) e dispara os eventos já existentes (`conversation.closed` e, na tabulação 142, `agreement.created`). `note` vira **nota do contato** (nunca vai ao cliente). Idempotente: já encerrada com a mesma tabulação = `changed: false`. Exige `conversations:write`.',
      parameters: [idParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('CloseConversationRequest'), example: { tabulation_code: 142, note: 'Acordo fechado por telefone, 3 parcelas.' } } },
      },
      responses: {
        '200': single('Conversa encerrada (ou já estava, com a mesma tabulação).', 'CloseConversationResult', {
          conversation: { id: conversationExample.id, status: 'closed', outcome: { id: '9d3c2f1e-0000-4000-8000-000000000050', code: 142, name: 'Acordo Realizado' }, closed_at: '2026-10-15T16:20:00.000Z' },
          changed: true,
        }),
        '400': apiError('Corpo inválido (sem tabulação, ou as duas ao mesmo tempo).', 'bad_request', "Informe 'tabulation_code' (ou 'tabulation_id'); veja GET /tabulations"),
        '401': resp('Unauthorized'),
        '403': resp('Forbidden'),
        '404': apiError('Conversa ou tabulação inexistente (ou de outra conta).', 'not_found', 'Tabulação não encontrada; veja GET /tabulations'),
        '409': apiError('A conversa já está encerrada com OUTRA tabulação (`error.reason = already_closed`).', 'conflict', 'A conversa já está encerrada com outra tabulação.', { reason: 'already_closed' }),
        '429': resp('RateLimited'),
        '500': resp('InternalError'),
        '503': unavailable,
      },
    },
  },
  '/conversations/{id}/transfer': {
    post: {
      tags: ['Atendimento'],
      operationId: 'transferConversation',
      summary: 'Transferir uma conversa',
      description:
        'Troca o atendente e/ou a equipe (`null` remove). **Atendente em pausa**: `409` (`error.reason = agent_paused`, com `agent` e `pause`); repita com `confirm_paused: true` para atribuir mesmo assim (fica marcado na auditoria). Conversa encerrada = `409` (`conversation_closed`). Sem mudança = `changed: false`. Exige `conversations:write`.',
      parameters: [idParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('TransferConversationRequest'), example: { assignee_id: '5b0e5a64-0000-4000-8000-000000000032', reason: 'Cliente pediu a Ana' } } },
      },
      responses: {
        '200': single('Conversa transferida (ou já estava assim).', 'TransferConversationResult', { conversation: conversationExample, changed: true }),
        '400': apiError('Corpo inválido (sem `assignee_id` nem `team_id`).', 'bad_request', "Informe 'assignee_id' e/ou 'team_id' (null remove)"),
        '401': resp('Unauthorized'),
        '403': resp('Forbidden'),
        '404': apiError('Conversa, atendente ou equipe inexistente (ou de outra conta).', 'not_found', 'Atendente não encontrado'),
        '409': apiError('Atendente em pausa (`agent_paused`) ou conversa encerrada (`conversation_closed`).', 'conflict', "Ana Souza está em pausa. Repita com 'confirm_paused': true para atribuir mesmo assim.", { reason: 'agent_paused' }),
        '429': resp('RateLimited'),
        '500': resp('InternalError'),
        '503': unavailable,
      },
    },
  },
};

const uuid = { type: 'string', format: 'uuid' };

export const atendimentoSchemas: Record<string, Json> = {
  ConversationRef: {
    type: 'object',
    required: ['id', 'status', 'contact_id'],
    properties: {
      id: uuid,
      status: { type: 'string', enum: ['open', 'pending', 'closed'], description: '`open` = em atendimento; `pending` = na fila; `closed` = encerrada.' },
      assignee_id: { type: ['string', 'null'], format: 'uuid' },
      team_id: { type: ['string', 'null'], format: 'uuid' },
      contact_id: uuid,
      channel: { type: 'object', properties: { id: { type: ['string', 'null'], format: 'uuid' }, waha_session: { type: ['string', 'null'] } } },
    },
  },
  OpenConversationRequest: {
    type: 'object',
    additionalProperties: false,
    description: 'Informe `phone` (ou `to`) **ou** `contact_id`.',
    properties: {
      phone: { type: 'string', description: 'Telefone em E.164 (ex.: `+5527999991212`). Acha o contato (inclusive por telefone alternativo) ou cria.' },
      to: { type: 'string', description: 'Sinônimo de `phone`.' },
      contact_id: uuid,
      name: { type: 'string', maxLength: 200, description: 'Nome, só ao criar o contato.' },
      channel: { type: 'string', description: 'Canal: id (UUID), número do canal Meta ou sessão WAHA. Sem ele, usa o único canal ativo.' },
      assignee_id: { ...uuid, description: 'Atendente (veja `GET /agents`).' },
      team_id: { ...uuid, description: 'Equipe (veja `GET /teams`).' },
      force_transfer: { type: 'boolean', default: false, description: 'Se já houver atendimento aberto com outro atendente/equipe, transfere em vez de responder 409.' },
      confirm_paused: { type: 'boolean', default: false, description: 'Confirma atribuir a atendente que está em pausa.' },
      reason: { type: 'string', maxLength: 500, description: 'Motivo (vai para o histórico de atribuição quando houver transferência).' },
      message: {
        type: 'object',
        additionalProperties: false,
        description: 'Mensagem inicial (opcional): `text` OU `template`. Com mensagem, `Idempotency-Key` é obrigatório.',
        properties: {
          text: { type: 'string', maxLength: 4096 },
          template: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' }, language: { type: 'string', default: 'pt_BR' }, variables: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 1024 } } },
          },
        },
      },
    },
  },
  OpenConversationResult: {
    type: 'object',
    required: ['conversation', 'transferred'],
    properties: {
      conversation: { allOf: [ref('ConversationRef'), { type: 'object', required: ['created'], properties: { created: { type: 'boolean', description: '`true` = abriu agora; `false` = já existia.' } } }] },
      transferred: { type: 'boolean', description: '`true` quando `force_transfer` mudou atendente/equipe de um atendimento existente.' },
      via_owner: { type: 'boolean', description: '`true` quando não veio atendente nem equipe e a conversa foi para o **dono do contato** (carteira fixa).' },
      message: {
        type: 'object',
        description: 'Só quando enviou mensagem inicial.',
        properties: { id: { type: ['string', 'null'], format: 'uuid' }, whatsapp_message_id: { type: 'string' }, kind: { type: 'string', enum: ['text', 'template'] }, saved: { type: 'boolean', description: '`false` = o provedor aceitou mas a gravação no CRM falhou (não reenvie).' } },
      },
    },
  },
  CloseConversationRequest: {
    type: 'object',
    additionalProperties: false,
    description: 'Informe `tabulation_code` OU `tabulation_id`.',
    properties: {
      tabulation_code: { type: 'integer', description: 'Código da tabulação (`GET /tabulations`, campo `code`).' },
      tabulation_id: uuid,
      note: { type: 'string', maxLength: 1000, description: 'Observação: vira nota do contato (nunca vai ao cliente).' },
    },
  },
  CloseConversationResult: {
    type: 'object',
    required: ['conversation', 'changed'],
    properties: {
      conversation: {
        type: 'object',
        properties: {
          id: uuid,
          status: { type: 'string', enum: ['closed'] },
          outcome: { type: 'object', properties: { id: uuid, code: { type: ['integer', 'null'] }, name: { type: 'string' } } },
          closed_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      changed: { type: 'boolean', description: '`false` = já estava encerrada com essa tabulação.' },
    },
  },
  TransferConversationRequest: {
    type: 'object',
    additionalProperties: false,
    description: 'Informe `assignee_id` e/ou `team_id` (`null` remove).',
    properties: {
      assignee_id: { type: ['string', 'null'], format: 'uuid' },
      team_id: { type: ['string', 'null'], format: 'uuid' },
      confirm_paused: { type: 'boolean', default: false },
      reason: { type: 'string', maxLength: 500 },
    },
  },
  TransferConversationResult: {
    type: 'object',
    required: ['conversation', 'changed'],
    properties: { conversation: ref('ConversationRef'), changed: { type: 'boolean' } },
  },
};
