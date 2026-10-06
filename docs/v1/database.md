# Banco de dados

## Plataforma

PostgreSQL via Supabase. Schema principal: `wacrm`.

Snapshot consultado: **75 tabelas base**.

## Grupos

Conta/acesso: `accounts`, `profiles`, `teams`, `team_members`, convites, presença e sessões.

Atendimento: `contacts`, telefones/identidades/tags/notas, `conversations`, `messages`, assignments e quick replies.

Flows: `flows`, `flow_nodes`, `flow_runs`, `flow_run_events`.

IA: `ai_config`, `ai_decisions`, `ai_reply_intents`, `ai_prompt_versions`.

Disparador: `campaigns`, import contacts, queue, metrics, receipts, outbox, limits e blacklist.

Canais: `whatsapp_config`, `channels`, webchat.

Observabilidade: `system_logs`, `audit_logs`, message logs, page views, sessions e intelligence tool calls.

## Campos importantes

`conversations` inclui account, status, agente, equipe, canal, origem, first response, last customer message, closed_at, assignment retry e `ai_in_progress_at`.

`ai_decisions` inclui handoff, exit code, tool, model, prompt version, ai_node e tool_error.

## Funções/RPC

Há RPCs para membership, bulk upsert, reports, campaign claims/status, cron locks, AI claim/release/debounce, invitations, audit e merge.

## Triggers

Cobrem updated_at, auditoria, routing, assignment, closed_at, SLA, account_id de mensagens, presença e agregações.

## RLS

RLS faz parte do modelo de segurança; service role só deve ser usada server-side com validação explícita.

## Drift de migrations

O repo possui 159 arquivos SQL no baseline, mas produção passou por reconciliação.

`wacrm.app_schema_version()` retorna **143** no snapshot, apesar de o live conter estruturas posteriores. Portanto:

- não usar somente esse número como prova de estado;
- não reaplicar migrations antigas às cegas;
- comparar schema live, histórico, migrations e contrato do runtime.
