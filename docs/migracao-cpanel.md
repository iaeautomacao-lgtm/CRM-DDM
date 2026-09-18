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

## Exportação necessária

1. Backup completo e dumps lógicos de schema e dados dos schemas utilizados.
2. Inventário de tabelas, contagens, constraints, índices, funções, triggers,
   extensões, políticas RLS, RPCs, webhooks e jobs.
3. Usuários do Auth e vínculos com contas/equipes. Senhas exigem análise de
   compatibilidade dos hashes ou redefinição controlada.
4. Arquivos de todos os buckets, mantendo nomes e caminhos. O backup do banco
   contém metadados, mas não os objetos do Storage.
5. Configurações e segredos por canal seguro, nunca pelo Git.

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

## Segurança

Uma chave `service_role` esteve escrita em três scripts de diagnóstico. Ela foi
removida da branch de migração, mas precisa ser rotacionada no Supabase após
coordenação com o ambiente atual. A remoção do arquivo não invalida uma credencial
já exposta no histórico Git.
