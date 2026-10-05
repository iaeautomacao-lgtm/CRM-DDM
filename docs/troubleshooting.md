# Troubleshooting

## Estratégia de investigação

Siga o evento do cliente até o efeito esperado. Não comece pela LLM apenas porque o sintoma envolve IA.

Para uma mensagem inbound:

```text
provider
  -> webhook
  -> contact/conversation
  -> messages
  -> flow_runs
  -> flow_run_events
  -> AI/tool call
  -> outbound send
  -> provider status
```

## Cliente enviou mensagem e não recebeu resposta

Verifique:

1. a mensagem existe em `wacrm.messages`;
2. `conversations.last_message_at` avançou;
3. existe run ativo em `flow_runs`;
4. houve `reply_received`;
5. debounce venceu;
6. houve `claim_ai_reply`;
7. tool call terminou;
8. existe `message_sent` ou erro posterior.

Um run `active` com `current_node_key=ai_agent` e sem avanço por muito tempo pode indicar execução órfã.

## Tool retorna erro mas evento aparece como success

Não confie apenas no status do evento ou HTTP.

Inspecione:

- `payload.tool_name`;
- `payload.result`;
- `error_message`;
- duração;
- código de classificação em `src/lib/ai/tool-recovery.ts`.

Providers podem responder HTTP 200 com erro no corpo.

## Mensagens duplicadas

Cheque:

- `message_id` externo;
- deduplicação do webhook;
- eventos `reply_received`;
- ledger/idempotency de envio;
- retries do provedor.

Não "corrija" duplicidade removendo guards sem reproduzir a corrida.

## Campanha parou

Verifique:

- status da campanha;
- janela/dias permitidos;
- `next_batch_at`;
- itens em `disp_message_queue`;
- estados `agendado/enviando/enviado/erro`;
- locks do cron;
- limites por canal;
- blacklist;
- erro Meta normalizado.

## Campanha envia mais de uma vez

Investigue:

- `claim_dispatch_item`;
- ledger de envio;
- reconciliação de recibos;
- timeout depois do provider aceitar;
- múltiplos crons concorrentes.

Nunca faça retry cego de item `enviando` sem entender se o provider já aceitou.

## Webhook Meta falha

Cheque:

- `META_APP_SECRET`;
- assinatura;
- phone number/config;
- status do token;
- payload recebido;
- logs da rota.

## WAHA não recebe ou não envia

Cheque:

- sessão ativa;
- secret do webhook;
- base URL;
- identificação da sessão;
- diferenças de formato WAHA vs Meta.

## `schema:check` bloqueia deploy

O banco não satisfaz o contrato mínimo esperado pelo código. Não desative o check.

1. leia o objeto/coluna que falhou;
2. confirme se o projeto Supabase é o correto;
3. compare migrations;
4. aplique migration/reconciliação;
5. rode o check novamente.

## Erros intermitentes de IA

Separe:

- erro do provider LLM;
- timeout;
- erro de ferramenta;
- resposta vazia;
- falha no envio;
- handoff;
- run órfão.

Use `flow_run_events` para reconstruir a linha do tempo.

## Dados inconsistentes entre UI e banco

Confirme:

- conta do usuário;
- RLS;
- filtros por equipe;
- cache/realtime;
- queries com paginação;
- registro efetivamente atualizado pelo backend.

## O que coletar em um bug report

- timestamp com timezone;
- conta/equipe;
- conversation ID;
- flow run ID;
- campaign/queue ID quando aplicável;
- endpoint envolvido;
- status HTTP;
- evento de erro;
- commit SHA;
- comportamento esperado vs observado.

Não inclua token, senha, service role, CPF completo ou payload sensível em issue pública.
