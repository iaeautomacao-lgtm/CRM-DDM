# Banco de dados e migrations

## Visão geral

O CRM DDM usa PostgreSQL via Supabase. O schema de aplicação é `wacrm`; código novo não deve assumir `public` para tabelas do CRM.

## Fonte de verdade

Em ambientes existentes, a fonte operacional de verdade é a combinação de:

1. schema live do Supabase;
2. migrations em `supabase/migrations/`;
3. probes de compatibilidade em `npm run schema:check`;
4. comportamento do código que está em produção.

Migrations antigas podem não representar exatamente o estado atual depois de correções manuais ou reconciliações. Antes de criar migration nova, inspecione o banco live.

## Convenções

- tabelas multi-tenant carregam `account_id` quando aplicável;
- acesso de usuário passa por RLS/policies;
- service role só é usada server-side;
- operações atômicas ou concorrentes devem preferir RPC;
- tabelas grandes devem ser paginadas;
- relacionamentos ambíguos no PostgREST precisam de hint de FK;
- `.single()` só deve ser usado quando unicidade é realmente garantida.

## Migrations

As migrations ficam em:

```text
supabase/migrations/
```

Use arquivo novo para alterações de schema. Não edite migration já aplicada para "corrigir" produção; isso quebra reprodutibilidade.

Padrão recomendado:

```text
NNN_descricao_curta.sql
```

Como o histórico possui numeração legada duplicada em alguns pontos, mantenha o padrão vigente e valide a ordem real antes de aplicar.

## Aplicação segura

Para banco novo:

1. faça backup/snapshot do destino;
2. aplique migrations em ordem;
3. pare no primeiro erro;
4. valide objetos críticos;
5. rode `npm run schema:check`;
6. execute testes de smoke.

Para banco existente:

1. inspecione tabelas, colunas, constraints, policies e funções live;
2. compare com a intenção da migration;
3. faça a alteração idempotente sempre que possível;
4. teste em staging;
5. mantenha rollback ou script corretivo.

## Schema readiness

O script `scripts/check-schema-readiness.mjs` impede deploy quando o banco configurado não atende o contrato mínimo esperado pelo build.

```bash
npm run schema:readiness
```

## Registro de migrations (`schema:check`)

A migration **202** cria `wacrm.schema_migrations` (versão = nome do arquivo sem `.sql`, `applied_at`, `applied_by`,
`source`) fechada ao service_role, e a RPC `wacrm.schema_check_report()`. O banco passa a dizer o que foi aplicado:

```bash
npm run schema:check
```

Lê `scripts/required-migrations.json` (gerado dos arquivos de `supabase/migrations`, a partir da 183) e imprime cada migration
como **aplicada**, **faltando** ou **índice inválido** (`CREATE INDEX CONCURRENTLY` interrompido deixa `indisvalid = false`).
Sai com código ≠ 0 se faltar algo (2 = erro: sem env, 202 não aplicada).

Regras:

- Toda migration nova com `BEGIN/COMMIT` termina registrando-se (modelo em `supabase/migrations/_MODELO.md`).
- Migration `NNNb` com `CREATE INDEX CONCURRENTLY` roda **sozinha** e NÃO se registra: o `schema:check` a detecta pelo índice.
- Ao criar uma migration, regenere a lista: `node scripts/schema-check.mjs --generate` e commite (o CI confere).
- O CI também falha se dois arquivos tiverem o mesmo número (`scripts/ci/check-migration-numbers.mjs`).
- A 202 registra por **detecção** o que já estava aplicado (cada migration ≥ 183 tem uma verificação objetiva no cabeçalho dela).

Ele não substitui migrations nem valida toda a semântica do banco. É um gate de compatibilidade.

## RLS e service role

Regra prática:

- navegador/SSR com sessão do usuário: respeita RLS;
- rotas server-side privilegiadas: podem usar service role;
- service role nunca deve ser exposta ao browser;
- qualquer endpoint que use service role precisa validar autenticação, conta e autorização antes de consultar ou alterar dados.

## Auditoria

O projeto mantém trilhas de auditoria e logs em tabelas específicas. Alterações em entidades sensíveis devem preservar:

- ator;
- conta;
- recurso;
- timestamp;
- origem da ação;
- contexto suficiente para investigação, sem gravar segredos.

## Checklist para mudança de schema

- [ ] schema live inspecionado;
- [ ] impacto em RLS avaliado;
- [ ] índices revisados;
- [ ] backfill necessário definido;
- [ ] compatibilidade com código antigo considerada;
- [ ] migration idempotente quando possível;
- [ ] `schema:check` atualizado se um novo objeto passar a ser obrigatório;
- [ ] documentação atualizada.
