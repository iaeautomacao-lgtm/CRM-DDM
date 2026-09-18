# Migração do Supabase para cPanel/MariaDB

## Estado atual

A aplicação ainda depende do Supabase para PostgreSQL, autenticação, autorização
via RLS, Storage, Realtime e RPCs. Importar somente as tabelas no MariaDB não é
suficiente para manter o sistema funcionando.

O trabalho deve permanecer na branch `migration/cpanel-mariadb`, usando domínio,
banco e integrações de homologação. O merge de código não transfere dados.

## Serviços do repositório

| Caminho | Responsabilidade |
| --- | --- |
| `src` | CRM Next.js e endpoints principais |
| `supabase/migrations` | Histórico do schema PostgreSQL e regras RLS/RPC |
| `disparador` | Aplicações NestJS/Next.js, fila BullMQ/Redis e Supabase |
| `voip` | Serviço Go e cliente de telefonia |
| `scripts/diagnostics` | Diagnósticos manuais fora do runtime |
| `app.js`, `.cpanel.yml` | Entrada Passenger e deploy cPanel existentes |

## Exportação

Scripts em `scripts/migration`, documentados no README de lá. Rodam somente
leitura. Saída em `CRM-DDM-backup/dump`, fora do repositório.

| Item | Situação |
| --- | --- |
| Schema, dados, backup custom | Exportado |
| Roles, grants, contagem por tabela | Exportado |
| Usuários com hash de senha, identities, buckets | Exportado |
| Arquivos do Storage | Exportado |

## Inventário medido na origem

Origem: PostgreSQL 17.6, projeto Supabase acessado via session pooler.

**Banco**

| Objeto | Quantidade |
| --- | --- |
| Tabelas no schema `wacrm` (a aplicação) | 50 |
| Tabelas no schema `public` (app legado de call center) | 14 |
| Funções PL/pgSQL | 54 |
| Triggers | 25 |
| Views | 11 |
| Índices | 100 |
| Chaves estrangeiras | 117 |
| Políticas RLS | 106 |

Tipos a converter: 278 colunas `uuid`, 141 `timestamptz`, 36 `jsonb`, 5 colunas
`ARRAY`, 1 enum (`account_role_enum`), 1 coluna gerada (`contacts.phone_normalized`).

As 106 políticas RLS seguem um único padrão: `is_account_member(account_id)`,
opcionalmente com papel mínimo (`admin`, `agent`). O isolamento multi-inquilino é
portanto uma regra só, não 106 — ela precisa passar a ser imposta em um ponto
central do backend.

O `pg_dump` alertou sobre chaves estrangeiras circulares em `messages`,
`automation_steps` e `teams`. O importador do MariaDB precisa desabilitar checagem
de FK durante a carga e reabilitar ao final.

**Aplicação**

| Consumo do Supabase | Ocorrências |
| --- | --- |
| `.from()` (queries PostgREST) | 758 |
| `.rpc()` (21 funções distintas) | 32 |
| `auth.getUser` | 54 |
| Canais Realtime | 4 |
| Buckets acessados no código | 3 |
| Selects com join embutido (`contact:contacts(*)`) | 24 |

**Autenticação**

27 usuários, todos com senha bcrypt (`$2a$`), que o Node verifica com `bcryptjs`.
Nenhum provedor OAuth, nenhum fator MFA, nenhum usuário banido ou excluído.
Sete são contas de teste (`test.*`, `testagent*`) e não devem ir para produção.

**Storage**

| Bucket | Público | Arquivos | Tamanho |
| --- | --- | --- | --- |
| `chat-media` | sim | 1.986 | 232 MB |
| `relatorio-exports` | não | 1 | ~0 |
| `avatars` | sim | 0 | — |
| `flow-media` | sim | 0 | — |

Caminho dos objetos: `account-<uuid>/<timestamp>-<nome-original>`.

Guardar dumps fora do repositório e de `public/`.

## Conversão para MariaDB

Confirmar produto e versão do banco no cPanel antes de escrever migrations.
Converter explicitamente UUIDs, JSONB, arrays, datas com fuso, enums, funções,
triggers, índices e constraints. RLS deve virar autorização no backend; RPCs devem
virar services e transações; Realtime e Storage precisam de substitutos próprios.

Criar migrations MariaDB versionadas e um importador idempotente. Validar contagem
por tabela, relações, registros órfãos, datas, Unicode, JSON e URLs de arquivos.

## Fases

1. Confirmar recursos do cPanel: Node, MariaDB/MySQL, SSH, cron, processos
   persistentes, Redis, memória, disco e limites de conexão.
2. Reproduzir lint, typecheck, testes e build atuais.
3. Criar conexão MariaDB, migrations e importador de homologação.
4. Migrar autenticação, contas/equipes e autorização por objeto.
5. Migrar contatos, inbox, pipelines, anexos, relatórios e automações por fatias.
6. Adaptar workers, retries, idempotência e concorrência do disparador.
7. Remover dependências Supabase/Vercel após substituir todos os consumidores.
8. Ensaiar backup, importação, publicação e rollback no domínio de homologação.
9. Coordenar pausa de escritas, exportação incremental e virada final.

## Achados de segurança

### ALTO — chave `service_role` exposta no repositório

Local: `scripts/diagnostics/*.js` (antes na raiz do projeto).

A chave estava escrita em três scripts de diagnóstico. Ela dá acesso total ao
banco, ignorando toda RLS. Foi removida da branch de migração, mas **remover do
arquivo não revoga a credencial** — ela continua válida e continua no histórico
Git. Precisa ser rotacionada no painel do Supabase, em coordenação com quem
mantém a aplicação publicada hoje, porque a rotação derruba o ambiente atual até
a nova chave ser configurada.

### ALTO — mídia de conversas em bucket público

Local: `storage.buckets` (`chat-media`, `avatars`, `flow-media`).

Os três buckets estão marcados como públicos e o código usa `getPublicUrl()`.
As 1.986 mídias de conversas de WhatsApp são legíveis por qualquer pessoa que
tenha a URL, sem autenticação e sem verificação de conta. O caminho inclui o
`account-<uuid>`, mas isso é ofuscação, não autorização.

Provável motivo de serem públicos: a URL é gravada em `messages.media_url` e
consumida por serviços externos (OpenAI). A substituição no cPanel precisa
resolver os dois lados — servir por rota autenticada que valide o `account_id`,
e usar URL assinada de validade curta para o consumo externo.

### MÉDIO — contas de teste no mesmo ambiente de produção

Sete das 27 contas são de teste (`test.admin@ddm.test`, `testagent*@grupoddm.com.br`).
Não devem ser migradas para o banco de produção do cPanel.
