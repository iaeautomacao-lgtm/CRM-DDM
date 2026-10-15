// OpenAPI da CARTEIRA FIXA (Onda 2, fase 1): PUT/DELETE /contacts/{id}/owner. Mesclado em openapi.ts (tag Contatos). Sem segredo: só contrato.

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const apiError = (description: string, code: string, message: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: { error: { code, message } } } },
});
const idParam = { name: 'id', in: 'path', required: true, description: 'ID do contato.', schema: { type: 'string', format: 'uuid' } };
const ownerOk = (description: string, owner: Json | null) => ({
  description,
  content: {
    'application/json': {
      schema: { type: 'object', required: ['data'], properties: { data: ref('ContactOwner') } },
      example: { data: { contact_id: 'c1d2e3f4-0000-4000-8000-000000000301', owner } },
    },
  },
});

export const CARTEIRA_GUIDE = [
  '',
  '### Carteira fixa (atendente-dono do contato)',
  '`PUT /contacts/{id}/owner` define o atendente-dono do contato (`assignee_id`, veja `GET /agents`) e `DELETE` remove. O contato passa a trazer `owner` em `GET /contacts` e `GET /contacts/{id}`. **Hoje a carteira é só cadastro**: o único efeito é em `POST /conversations`, que, sem `assignee_id` nem `team_id`, abre o atendimento **para o dono** (se ele estiver ativo e fora de pausa; senão vai para a fila) e avisa em `via_owner: true`. A distribuição automática (campanha, cliente que escreve, fluxo) continua como antes. Exige `contacts:write`.',
].join('\n');

export const carteiraPaths: Record<string, Json> = {
  '/contacts/{id}/owner': {
    put: {
      tags: ['Contatos'],
      operationId: 'setContactOwner',
      summary: 'Definir o atendente-dono do contato (carteira fixa)',
      description:
        'Grava `assignee_id` como dono do contato (substitui o anterior). Repetir é seguro. Atendente de outra conta, desativado ou que não atende (visualizador) responde `404`. Exige `contacts:write`. Sem a migration 372: `503`.',
      parameters: [idParam],
      requestBody: { required: true, content: { 'application/json': { schema: ref('SetContactOwnerRequest'), example: { assignee_id: '5b0e5a64-0000-4000-8000-000000000032' } } } },
      responses: {
        '200': ownerOk('Dono gravado.', { id: '5b0e5a64-0000-4000-8000-000000000032', name: 'Ana Souza' }),
        '400': apiError('`assignee_id` ausente ou inválido, ou campo desconhecido.', 'bad_request', "'assignee_id' é obrigatório e deve ser um id (UUID); veja GET /agents"),
        '401': resp('Unauthorized'),
        '403': resp('Forbidden'),
        '404': apiError('Contato ou atendente inexistente (ou de outra conta).', 'not_found', 'Atendente não encontrado'),
        '429': resp('RateLimited'),
        '500': resp('InternalError'),
        '503': apiError('Carteira fixa ainda não habilitada no banco (migration 372).', 'unavailable', 'Carteira fixa indisponível: aplique a migration 372'),
      },
    },
    delete: {
      tags: ['Contatos'],
      operationId: 'removeContactOwner',
      summary: 'Remover o atendente-dono do contato',
      description: 'Tira o contato da carteira (`owner: null`). Repetir é seguro. Exige `contacts:write`.',
      parameters: [idParam],
      responses: {
        '200': ownerOk('Contato fora da carteira.', null),
        '401': resp('Unauthorized'),
        '403': resp('Forbidden'),
        '404': apiError('Contato inexistente (ou de outra conta).', 'not_found', 'Contato não encontrado'),
        '429': resp('RateLimited'),
        '500': resp('InternalError'),
        '503': apiError('Carteira fixa ainda não habilitada no banco (migration 372).', 'unavailable', 'Carteira fixa indisponível: aplique a migration 372'),
      },
    },
  },
};

export const carteiraSchemas: Record<string, Json> = {
  SetContactOwnerRequest: {
    type: 'object',
    required: ['assignee_id'],
    additionalProperties: false,
    properties: { assignee_id: { type: 'string', format: 'uuid', description: 'Atendente (veja `GET /agents`).' } },
  },
  ContactOwner: {
    type: 'object',
    required: ['contact_id', 'owner'],
    properties: {
      contact_id: { type: 'string', format: 'uuid' },
      owner: { oneOf: [{ type: 'null' }, { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } }] },
    },
  },
};
