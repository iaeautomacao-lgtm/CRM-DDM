// OpenAPI dos CONTATOS (bloco C da Onda 1): GET/POST /contacts e GET/PATCH /contacts/{id}, schemas e guia.
// Mesclado em openapi.ts no mesmo padrão de openapi-extract.ts. Sem segredo e sem CPF em claro: só contrato.

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const apiError = (description: string, code: string, message: string, extra: Json = {}) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorEnvelope'), example: { error: { code, message, ...extra } } } },
});
const common = { '401': resp('Unauthorized'), '403': resp('Forbidden'), '429': resp('RateLimited'), '500': resp('InternalError') };
const unavailable = apiError('Banco indisponível no momento.', 'unavailable', 'Não foi possível consultar os contatos; tente novamente');

export const CONTACTS_GUIDE = [
  '',
  '## Contatos',
  'Busque, crie e atualize contatos da conta. **Buscar**: `GET /contacts` exige ao menos um filtro (`phone`, `cpf`, `email`, `q`, `tag`, `updated_from`/`updated_to`) e devolve no máximo 200 por página, com `next_cursor`. **Criar ou completar**: `POST /contacts` é um *upsert*: acha o contato pelo **CPF** (primeiro) ou pelo **telefone** e, se ele já existe, **preenche só o que está vazio** (nunca troca o telefone principal nem sobrescreve dado que já existe). **Corrigir**: `PATCH /contacts/{id}` **sobrescreve** os campos enviados.',
  '',
  '**CPF:** nunca sai em claro. A resposta traz `cpf_masked` (`***.***.***-12`) e `has_cpf`. Para achar alguém pelo CPF use o filtro `cpf` (comparação exata; pode haver mais de um contato com o mesmo CPF). **Campos personalizados:** só os que já existem na conta (nome igual ao cadastrado); nome desconhecido responde `422` com a lista em `error.unknown_custom_fields` e nada é gravado. **Etiquetas:** as que não existem são criadas; `IA Conversando` e `Atendimento Humano` são automáticas e a API recusa (`400`). **Limites:** 60 consultas por minuto por chave em `GET /contacts` e `GET /contacts/{id}` (além dos 120/min gerais). Não há exclusão, mesclagem nem importação em lote por esta API.',
].join('\n');

export const contactsTags = [{ name: 'Contatos', description: 'Buscar, criar (upsert) e atualizar contatos (escopos contacts:read e contacts:write).' }];

const contactExample = {
  id: 'c1d2e3f4-0000-4000-8000-000000000301',
  phone: '5527999991212',
  phones: [{ phone: '+5527988887777', status: 'ativo', label: 'Trabalho' }],
  name: 'Ana Souza',
  email: 'ana@exemplo.com.br',
  company: 'Exemplo Ltda',
  institution: 'Faculdade Exemplo',
  cpf_masked: '***.***.***-12',
  has_cpf: true,
  tags: ['Inadimplente'],
  custom_fields: { Curso: 'Direito' },
  created_at: '2026-10-01T12:00:00.000Z',
  updated_at: '2026-10-14T09:30:00.000Z',
};

const single = (description: string, extra: Json = {}) => ({
  description,
  content: {
    'application/json': {
      schema: { type: 'object', required: ['data'], properties: { data: ref('ContactResult') } },
      example: { data: { contact: contactExample, ...extra } },
    },
  },
});

const idParam = { name: 'id', in: 'path', required: true, description: 'ID do contato.', schema: { type: 'string', format: 'uuid' } };
const notFound = apiError('Contato inexistente ou de outra conta.', 'not_found', 'Contato não encontrado');

export const contactsPaths: Record<string, Json> = {
  '/contacts': {
    get: {
      tags: ['Contatos'],
      operationId: 'listContacts',
      summary: 'Buscar contatos',
      description:
        'Contatos da conta da chave, em ordem crescente de `updated_at` (e `id`), o que permite sincronização incremental (guarde o último `updated_at`). **Exige ao menos um filtro**; vários filtros se combinam (E). `phone` aceita telefone alternativo; `cpf` é exato; `q` é prefixo do nome (3+ letras); `tag` é o nome da etiqueta. O CPF nunca sai em claro. Cada consulta é **auditada** (chave, rota, filtros e quantidade; nunca o conteúdo). Exige `contacts:read` (ou `contacts:write`).',
      parameters: [
        { name: 'phone', in: 'query', required: false, description: 'Telefone (DDI + DDD + número); acha também por telefone alternativo.', schema: { type: 'string' } },
        { name: 'cpf', in: 'query', required: false, description: 'CPF (com ou sem pontuação). Pode devolver mais de um contato.', schema: { type: 'string' } },
        { name: 'email', in: 'query', required: false, description: 'E-mail exato (sem diferenciar maiúsculas).', schema: { type: 'string' } },
        { name: 'q', in: 'query', required: false, description: 'Início do nome (mínimo 3 letras).', schema: { type: 'string', minLength: 3 } },
        { name: 'tag', in: 'query', required: false, description: 'Nome da etiqueta.', schema: { type: 'string' } },
        { name: 'updated_from', in: 'query', required: false, description: 'Atualizados a partir de (inclusivo), ISO 8601.', schema: { type: 'string', format: 'date-time' } },
        { name: 'updated_to', in: 'query', required: false, description: 'Atualizados até (exclusivo), ISO 8601.', schema: { type: 'string', format: 'date-time' } },
        { name: 'limit', in: 'query', required: false, description: 'Itens por página (1 a 200).', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        { name: 'cursor', in: 'query', required: false, description: 'Cursor opaco devolvido em `next_cursor`.', schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'Página de contatos.',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: ref('ContactPage') } },
              example: { data: { items: [contactExample], next_cursor: null } },
            },
          },
        },
        '400': apiError('Nenhum filtro informado, filtro inválido, `limit` ou `cursor` inválido.', 'bad_request', 'Informe ao menos um filtro: phone, cpf, email, q, tag, updated_from ou updated_to'),
        ...common,
        '503': unavailable,
      },
    },
    post: {
      tags: ['Contatos'],
      operationId: 'upsertContact',
      summary: 'Criar ou completar um contato (upsert)',
      description: [
        'Acha o contato pelo **CPF** (primeiro) ou pelo **telefone**. Se não existe, cria (`201`, `created: true`). Se existe, **preenche só o que está vazio** (`200`, `created: false`, com `updated_fields`): nome que é só um telefone conta como vazio; o CPF só entra se o contato não tem; o telefone principal nunca muda; telefones de `phones` que já pertencem a algum contato vão em `ignored_phones`.',
        '',
        'Etiquetas inexistentes são criadas. Campos personalizados só os já cadastrados (senão `422`). O `Idempotency-Key` é opcional: o upsert já é idempotente, então repetir a chamada não duplica nada (devolve `created: false` e `updated_fields` vazio). Exige `contacts:write`.',
      ].join('\n'),
      parameters: [
        { name: 'Idempotency-Key', in: 'header', required: false, description: 'Opcional (8–128 caracteres). Validada, mas o upsert já é idempotente por CPF/telefone.', schema: { type: 'string', minLength: 8, maxLength: 128 } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: ref('ContactUpsertRequest'),
            example: {
              phone: '5527999991212',
              name: 'Ana Souza',
              email: 'ana@exemplo.com.br',
              cpf: '123.456.789-09',
              institution: 'Faculdade Exemplo',
              phones: ['5527988887777'],
              tags: ['Inadimplente'],
              custom_fields: { Curso: 'Direito' },
            },
          },
        },
      },
      responses: {
        '200': single('Contato já existia: só os campos vazios foram preenchidos.', { created: false, updated_fields: ['email'], ignored_phones: [] }),
        '201': single('Contato criado.', { created: true, updated_fields: [], ignored_phones: [] }),
        '400': apiError('Corpo inválido: telefone, CPF, e-mail, campo desconhecido, etiqueta automática, `Idempotency-Key` malformada.', 'bad_request', 'Telefone inválido (use DDI + DDD + número)'),
        '401': resp('Unauthorized'),
        '403': resp('Forbidden'),
        '409': apiError('Conflito ao criar (corrida no mesmo número). Tente de novo.', 'conflict', 'Conflito ao criar o contato; tente novamente'),
        '422': apiError('Campo personalizado que não existe na conta. Nada foi gravado.', 'unprocessable', 'Campo(s) personalizado(s) inexistente(s) nesta conta: Curso. Crie-os em Configurações antes.', { unknown_custom_fields: ['Curso'] }),
        '429': resp('RateLimited'),
        '500': resp('InternalError'),
        '503': unavailable,
      },
    },
  },
  '/contacts/{id}': {
    get: {
      tags: ['Contatos'],
      operationId: 'getContact',
      summary: 'Ler um contato',
      description: 'Um contato da conta da chave, com telefones alternativos, etiquetas e campos personalizados. O CPF vem só mascarado. Contato de outra conta responde `404`. Exige `contacts:read` (ou `contacts:write`).',
      parameters: [idParam],
      responses: {
        '200': single('O contato.'),
        '404': notFound,
        ...common,
        '503': unavailable,
      },
    },
    patch: {
      tags: ['Contatos'],
      operationId: 'updateContact',
      summary: 'Atualizar um contato (sobrescreve)',
      description: [
        '**Sobrescreve** os campos enviados (diferente do `POST`, que só preenche vazios). `null` limpa `email`, `company`, `institution` e `cpf`. `name` vazio **não** apaga o nome e o telefone principal **não** muda (enviar um `phone` diferente é `400`).',
        '',
        '`phones` vira a lista **exata** de telefones alternativos (telefone de outro contato = `409`). `tags` aceita `{ add: [...], remove: [...] }`. `custom_fields` faz *merge*: `null` apaga o valor; nome inexistente é `422`. Exige `contacts:write`.',
      ].join('\n'),
      parameters: [idParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: ref('ContactPatchRequest'),
            example: { email: null, company: 'Nova Empresa', tags: { add: ['Acordo'], remove: ['Inadimplente'] }, custom_fields: { Curso: null } },
          },
        },
      },
      responses: {
        '200': single('Contato atualizado.', { updated_fields: ['company', 'tags'] }),
        '400': apiError('Corpo inválido, nenhum campo enviado, telefone principal diferente do atual ou etiqueta automática.', 'bad_request', 'Envie ao menos um campo para alterar'),
        '401': resp('Unauthorized'),
        '403': resp('Forbidden'),
        '404': notFound,
        '409': apiError('Um dos telefones já pertence a outro contato da conta.', 'conflict', 'Um dos telefones já pertence a outro contato desta conta', { reason: 'phone_in_use' }),
        '422': apiError('Campo personalizado que não existe na conta. Nada foi gravado.', 'unprocessable', 'Campo(s) personalizado(s) inexistente(s) nesta conta: Curso. Crie-os em Configurações antes.', { unknown_custom_fields: ['Curso'] }),
        '429': resp('RateLimited'),
        '500': resp('InternalError'),
        '503': unavailable,
      },
    },
  },
};

const text = (description: string) => ({ type: ['string', 'null'], description });

export const contactsSchemas: Record<string, Json> = {
  Contact: {
    type: 'object',
    required: ['id', 'phone', 'phones', 'has_cpf', 'tags', 'custom_fields'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      phone: { type: 'string', description: 'Telefone principal.' },
      phones: {
        type: 'array',
        description: 'Telefones alternativos.',
        items: {
          type: 'object',
          required: ['phone'],
          properties: { phone: { type: 'string' }, status: { type: ['string', 'null'], description: '`ativo`, `invalido` ou `respondeu`.' }, label: { type: ['string', 'null'] } },
        },
      },
      name: text('Nome.'),
      email: text('E-mail.'),
      company: text('Empresa.'),
      institution: text('Instituição.'),
      cpf_masked: text('CPF mascarado (`***.***.***-12`). O CPF em claro nunca é devolvido.'),
      has_cpf: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Nomes das etiquetas de contato.' },
      custom_fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Campos personalizados com valor: `{ nome_do_campo: valor }`.' },
      owner: { oneOf: [{ type: 'null' }, { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } }], description: 'Atendente-dono do contato (carteira fixa; veja `PUT /contacts/{id}/owner`). `null` = sem dono.' },
      created_at: { type: ['string', 'null'], format: 'date-time' },
      updated_at: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  ContactPage: {
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: { items: { type: 'array', items: ref('Contact') }, next_cursor: { type: ['string', 'null'], description: '`null` = fim.' } },
  },
  ContactResult: {
    type: 'object',
    required: ['contact'],
    properties: {
      contact: ref('Contact'),
      created: { type: 'boolean', description: 'Só no `POST`.' },
      updated_fields: { type: 'array', items: { type: 'string' }, description: 'Campos preenchidos (POST em contato existente) ou alterados (PATCH).' },
      ignored_phones: { type: 'array', items: { type: 'string' }, description: 'Só no `POST`: telefones de `phones` que não foram adicionados (já pertencem a algum contato ou passou do limite de 5).' },
    },
  },
  ContactUpsertRequest: {
    type: 'object',
    required: ['phone'],
    additionalProperties: false,
    properties: {
      phone: { type: 'string', description: 'Telefone principal (DDI + DDD + número).' },
      name: { type: 'string', maxLength: 200 },
      email: { type: 'string' },
      company: { type: 'string', maxLength: 200 },
      institution: { type: 'string', maxLength: 200 },
      cpf: { type: 'string', description: 'CPF (com ou sem pontuação). Validado.' },
      phones: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'Telefones alternativos.' },
      tags: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Nomes de etiqueta (as inexistentes são criadas).' },
      custom_fields: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] }, description: 'Só campos já cadastrados na conta.' },
    },
  },
  ContactPatchRequest: {
    type: 'object',
    additionalProperties: false,
    description: 'Envie ao menos um campo.',
    properties: {
      phone: { type: 'string', description: 'Só aceito se igual ao telefone principal atual (o principal não muda).' },
      name: { type: ['string', 'null'], description: 'Vazio ou `null` não apaga o nome.' },
      email: { type: ['string', 'null'] },
      company: { type: ['string', 'null'] },
      institution: { type: ['string', 'null'] },
      cpf: { type: ['string', 'null'] },
      phones: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'Lista exata de telefones alternativos.' },
      tags: {
        type: 'object',
        additionalProperties: false,
        properties: { add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } },
      },
      custom_fields: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] }, description: '`null` apaga o valor.' },
    },
  },
};
