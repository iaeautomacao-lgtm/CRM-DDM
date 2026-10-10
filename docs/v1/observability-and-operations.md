# Observabilidade e operação

## Fontes

- `flow_run_events`: timeline de flow;
- `ai_decisions`: decisão estruturada;
- `system_logs`: aplicação;
- `audit_logs`: auditoria funcional;
- `message_logs`;
- page/user sessions;
- campaign queue/receipts;
- logs Supabase/Passenger/provider.

## Eventos de flow

Incluem node entered/completed, tool called/result, reply received, message sent, handoff, error e run completed.

## DDM Intelligence

Métricas versionadas incluem:

- conversas;
- primeira resposta média/p90;
- AI runs;
- handoff/failure/containment;
- fallback;
- tool success/latency;
- flow completion;
- breakdown por agente.

## Health/stress

`POST /api/stress/run` é protegido por secret. Scripts de stress cobrem geração, import, queue, webhook, E2E, report e cleanup.

## Investigação

Mensagem:

```text
provider -> webhook -> messages/conversation -> flow_run -> events -> AI/tool -> outbound -> receipt
```

Campanha:

```text
campaign -> audience -> queue -> claim -> provider -> mark sent -> receipt -> metrics/callback
```

## Deploy

CI verde, migration validada, env pronto, schema check, build e restart.

Rollback de código não implica rollback seguro de schema; migrations destrutivas exigem plano próprio.
