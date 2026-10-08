# Getting started

## Pré-requisitos

- Node.js 20.x
- npm 10.x
- Git
- acesso a um projeto Supabase
- credenciais apenas para os canais/recursos que serão usados

Para reproduzir o runtime de produção, prefira Node `20.19.0`.

## 1. Clonar e instalar

```bash
git clone https://github.com/iaeautomacao-lgtm/CRM-DDM.git
cd CRM-DDM
npm ci
```

## 2. Criar o arquivo de ambiente

```bash
cp .env.local.example .env.local
```

No mínimo, configure:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ENCRYPTION_KEY=
META_APP_SECRET=
```

Não use valores de produção em máquinas não confiáveis. Nunca envie `.env.local` para o Git.

Veja [configuration.md](./configuration.md) para as variáveis opcionais.

## 3. Preparar o banco

O CRM usa o schema PostgreSQL `wacrm`.

Para um banco novo, aplique as migrations de `supabase/migrations/` em ordem lexical, validando erros a cada etapa. Em banco existente, **não reaplique migrations às cegas**: primeiro compare o schema live com o histórico do repositório.

Depois execute:

```bash
npm run schema:readiness
```

O comando consulta o banco e falha se objetos críticos esperados pelo build estiverem ausentes.

> `all_migrations.sql` é um artefato consolidado histórico. Para mudanças novas, use migrations versionadas.

## 4. Iniciar a aplicação

```bash
npm run dev
```

Acesse `http://localhost:3000`.

## 5. Criar/validar conta e usuário

A autenticação é feita pelo Supabase Auth. O usuário precisa estar associado a uma conta/perfil compatível com as policies do schema.

Em ambientes já configurados, use o fluxo normal de autenticação/invite do CRM. Evite inserts manuais em tabelas de perfil sem conhecer as migrations de account sharing e roles.

## 6. Conectar um canal

O CRM suporta diferentes caminhos:

- Meta Cloud API;
- WAHA;
- Instagram/Messenger;
- Webchat.

Configure apenas um canal por vez durante o primeiro setup e valide envio/recebimento antes de adicionar outro.

Veja [integrations.md](./integrations.md).

## 7. Validar o ambiente

Antes de desenvolver:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

O mesmo conjunto é executado em CI, além de builds auxiliares.

## Fluxo recomendado de desenvolvimento

1. atualize `main`;
2. crie uma branch curta;
3. reproduza o problema ou defina o comportamento esperado;
4. implemente com testes;
5. rode lint/typecheck/test/build;
6. atualize documentação quando contrato, configuração ou operação mudar;
7. abra PR.

## Problemas frequentes no setup

### `schema:check` falha

O código está mais novo que o banco configurado, ou a service role não aponta para o projeto correto. Veja [database.md](./database.md).

### Webhook recebe mas nada responde

Confirme, em ordem:

1. mensagem persistida em `messages`;
2. conversa criada/atualizada;
3. flow run ativo;
4. eventos de `flow_run_events`;
5. chamada da IA;
6. tool results;
7. envio no provedor.

Veja [troubleshooting.md](./troubleshooting.md).

### Build funciona localmente e falha no deploy

Cheque Node, variáveis server-side e compatibilidade do schema antes de investigar o frontend.
