// OpenAPI dos CATÁLOGOS do atendimento (Onda 2): GET /tabulations, /agents e /teams. Mesclado em openapi.ts no padrão de openapi-contacts.ts.
// Sem dado sensível: só cadastro e status (sem métricas, e-mail ou telefone de atendente).

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const apiError = (description: string, code: string, message: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: { error: { code, message } } } },
});
const common = { '401': resp('Unauthorized'), '403': resp('Forbidden'), '429': resp('RateLimited'), '500': resp('InternalError') };
const unavailable = apiError('Banco indisponível no momento.', 'unavailable', 'Não foi possível consultar os atendentes; tente novamente');

export const CATALOGOS_GUIDE = [
  '',
  '## Controle do atendimento',
  'Rotas para integrar o seu sistema ao atendimento: **catálogos** (`GET /tabulations`, `GET /agents`, `GET /teams`) e, com o escopo `conversations:write`, abrir, encerrar e transferir conversas. Os catálogos aceitam `conversations:read` ou `conversations:write`, têm limite próprio de **60 consultas por minuto por chave** e trazem só cadastro e status: **sem métricas, sem e-mail e sem telefone do atendente**. O status do atendente (`online`, `away`, `offline`) usa a mesma regra do painel; `paused` e `pause` mostram quem está em pausa (o motivo e desde quando).',
].join('\n');

export const catalogosTags = [{ name: 'Atendimento', description: 'Catálogos do atendimento e controle de conversas (escopos conversations:read e conversations:write).' }];

const limitParam = { name: 'limit', in: 'query', required: false, description: 'Itens por página (1 a 200).', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } };
const cursorParam = { name: 'cursor', in: 'query', required: false, description: 'Cursor opaco devolvido em `next_cursor`.', schema: { type: 'string' } };

export const catalogosPaths: Record<string, Json> = {
  '/tabulations': {
    get: {
      tags: ['Atendimento'],
      operationId: 'listTabulations',
      summary: 'Listar tabulações',
      description: 'Catálogo de tabulações (motivos de encerramento) da conta. Use o `code` (estável entre ambientes; 142 = Acordo Realizado) ou o `id` em `POST /conversations/{id}/close`. Exige `conversations:read` (ou `conversations:write`).',
      responses: {
        '200': {
          description: 'Tabulações da conta, por código.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('Tabulation') } } } } },
              example: { data: { items: [{ id: '9d3c2f1e-0000-4000-8000-000000000050', code: 142, name: 'Acordo Realizado', color: '#16a34a' }] } },
            },
          },
        },
        ...common,
        '503': unavailable,
      },
    },
  },
  '/agents': {
    get: {
      tags: ['Atendimento'],
      operationId: 'listAgents',
      summary: 'Listar atendentes',
      description: 'Atendentes ativos da conta (operador, supervisor, administrador e proprietário), com status e pausa atual. **Só cadastro e status**: nada de métricas, e-mail ou telefone. Ordem estável (`created_at`, `id`), com cursor. Exige `conversations:read` (ou `conversations:write`).',
      parameters: [
        { name: 'team_id', in: 'query', required: false, description: 'Só os membros desta equipe (UUID).', schema: { type: 'string', format: 'uuid' } },
        { name: 'role', in: 'query', required: false, description: 'Papel.', schema: { type: 'string', enum: ['owner', 'admin', 'supervisor', 'agent'] } },
        { name: 'status', in: 'query', required: false, description: 'Status de presença agora.', schema: { type: 'string', enum: ['online', 'away', 'offline'] } },
        limitParam,
        cursorParam,
      ],
      responses: {
        '200': {
          description: 'Página de atendentes.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: ref('AgentPage') } },
              example: {
                data: {
                  items: [
                    { id: '5b0e5a64-0000-4000-8000-000000000032', name: 'Ana Souza', role: 'agent', team_ids: ['5b0e5a64-0000-4000-8000-000000000031'], status: 'online', paused: true, pause: { reason: 'Almoço', since: '2026-10-15T15:00:00.000Z' }, max_simultaneous_chats: 8 },
                  ],
                  next_cursor: null,
                },
              },
            },
          },
        },
        '400': apiError('Filtro, `limit` ou `cursor` inválido.', 'bad_request', "'status' inválido. Use: online, away, offline"),
        ...common,
        '503': unavailable,
      },
    },
  },
  '/teams': {
    get: {
      tags: ['Atendimento'],
      operationId: 'listTeams',
      summary: 'Listar equipes',
      description: 'Equipes da conta (até 200), com a equipe de transbordo e os ids dos membros. Exige `conversations:read` (ou `conversations:write`).',
      responses: {
        '200': {
          description: 'Equipes da conta.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('Team') } } } } },
              example: { data: { items: [{ id: '5b0e5a64-0000-4000-8000-000000000031', name: 'Cobrança Graduação', overflow_team_id: null, member_ids: ['5b0e5a64-0000-4000-8000-000000000032'] }] } },
            },
          },
        },
        ...common,
        '503': unavailable,
      },
    },
  },
};

export const catalogosSchemas: Record<string, Json> = {
  Tabulation: {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      code: { type: ['integer', 'null'], description: 'Código da tabulação (estável entre ambientes).' },
      name: { type: 'string' },
      color: { type: ['string', 'null'] },
    },
  },
  Team: {
    type: 'object',
    required: ['id', 'name', 'member_ids'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      overflow_team_id: { type: ['string', 'null'], format: 'uuid', description: 'Equipe que recebe o excedente quando ninguém desta está disponível.' },
      member_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
    },
  },
  Agent: {
    type: 'object',
    required: ['id', 'name', 'role', 'status', 'paused'],
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Use como `assignee_id`.' },
      name: { type: 'string' },
      role: { type: 'string', enum: ['owner', 'admin', 'supervisor', 'agent'] },
      team_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      status: { type: 'string', enum: ['online', 'away', 'offline'], description: 'Presença agora (online = ativo nos últimos 75 s).' },
      paused: { type: 'boolean', description: 'Em pausa de atendimento: não recebe conversa nova automática.' },
      pause: {
        oneOf: [{ type: 'null' }, { type: 'object', required: ['reason', 'since'], properties: { reason: { type: 'string' }, since: { type: 'string', format: 'date-time' } } }],
      },
      max_simultaneous_chats: { type: ['integer', 'null'], description: 'Teto de conversas abertas; `null` = sem teto.' },
    },
  },
  AgentPage: {
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items: ref('Agent') }, next_cursor: { type: ['string', 'null'], description: '`null` = fim.' } },
  },
};
