# Flow Engine da V1

## Persistência

Tabelas principais:

- `flows`
- `flow_nodes`
- `flow_runs`
- `flow_run_events`

Arestas vivem no JSONB dos nós e usam `node_key` estável.

## Triggers

- `keyword`
- `first_inbound_message`
- `manual`
- `called_by_flow`

## Tipos de nó

`start`, `send_message`, `send_buttons`, `send_list`, `send_media`, `collect_input`, `condition`, `switch`, `set_tag`, `handoff`, `handoff_agent`, `handoff_team`, `end`, `http_fetch`, `set_variable`, `smart_delay`, `anchor`, `go_to`, `go_to_flow`, `send_template`, `add_note`, `receive_attachment`, `ai_agent`, `send_webchat`.

## Máquina de estados

```text
evento
 -> iniciar/localizar run
 -> carregar nó
 -> executar
 -> registrar evento
 -> avançar ou estacionar
 -> persistir estado
```

O run armazena nó atual, vars, wake time, hops, debounce, timestamps e motivo de término.

## IA em loop

`mode=loop` responde e aguarda nova mensagem no mesmo nó. Há:

- `max_turns`;
- debounce;
- claim de resposta;
- heartbeat;
- watchdog;
- regras de turnos isentos;
- proteção para não executar dois agentes de loop com o mesmo inbound quando o primeiro já respondeu.

## Exit tags

Tags estruturadas alimentam `ai_exit_code` e podem ser roteadas por switch. O editor valida tags sem ramo.

## Handoff

Handoffs registram razão/subrazão e alimentam eventos e `ai_decisions`.

## Delay

`smart_delay` persiste `wake_at`; o cron retoma runs elegíveis.

## Export

`scripts/export-flow.mjs` exporta fluxo e nós de forma determinística e mascara segredos reconhecíveis.

## Limitação

O campo `CollectInputNodeConfig.validation` existe, mas a V1 não aplica email/phone/regex no runner.
