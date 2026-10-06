# Disparador da V1

## Core

Entidades:

- `campaigns`
- `disp_import_contacts`
- `disp_message_queue`
- `campaign_metrics`
- `dispatch_status_receipts`
- `campaign_callback_outbox`
- `dispatch_channel_limits`
- `blacklist`
- `contact_import_variables`
- templates/UTM

## Audience

Modos de público incluem CSV, tags e conta. Importações ficam vinculadas explicitamente à campanha.

## Importação

A V1 corrige:

- deduplicação no mesmo arquivo;
- telefone com/sem 55 e 9;
- persistência de VAR;
- falha de um lote sem abortar todos;
- leitura integral da blacklist.

## Fila

Cada item guarda contato, campanha, linha, mensagem, scheduled/sent time, status, tentativas, erro, template, provider id e account id.

## Concorrência

Claims e locks no banco evitam disputa. Batch lógico e concorrência externa são controles distintos.

## Batch

No baseline:

- `scheduled_at` controla a cadência lógica;
- lote segmentado não reaplica pausa em cada tick;
- o cron lê até 700 candidatos;
- concorrência externa continua limitada.

## Janela e dias

Aceita `HH:MM`, segundos e fração. Dias permitidos também fazem parte da configuração.

## Erros/retry

Meta 131026 é terminal conforme as regras atuais e não deve ser ressuscitado por retry.

## Receipts e callbacks

Status assíncronos possuem receipt/reconcile. Callback usa outbox persistida.

## UTM

UTMPay é chamado server-side.

## Fora da V1

Pausa automática por taxa de erro, evolução de item travado e limpeza adicional de receipts são V2 (#62).
