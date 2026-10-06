# Canais, Inbox e roteamento

## Meta WhatsApp

Suporta inbound, outbound, templates, mídia, status, reações e configuração por linha.

Webhook principal: `/api/whatsapp/webhook`.

## WAHA

Sessão, QR/pairing, webhook, envio e mídia. Webhook: `/api/whatsapp/webhook/waha`.

## Instagram/Messenger

Usam a fundação `channels` e `/api/meta/webhook`.

## Webchat

Possui settings, sessões por token, mensagens, upload e integração com flows.

## Modelo de atendimento

Core:

- `contacts`
- `contact_identities`
- `conversations`
- `messages`
- `conversation_assignments`

`conversations` guarda canal, linha, equipe, agente, origem, sentimento, SLA e heartbeat da IA.

## Roteamento

Considera linha, equipe, atendente, limites de simultaneidade e retry de assignment.

## Origem

A V1 distingue receptivo/ativo e correlaciona campanha, queue item e linha quando aplicável.

## Realtime

A Inbox usa realtime, mas possui resync por foco/visibilidade e sincronização periódica para convergir quando RLS impede o UPDATE de chegar ao navegador.

## Paginação

Há carregamento incremental e contagens reais por seção.

## Tabulação

A V1 contém fechamento/reabertura e sugestão de tabulação com escopo por conta/equipe. A sugestão persistida baseada em exit tag é V2 (#71).
