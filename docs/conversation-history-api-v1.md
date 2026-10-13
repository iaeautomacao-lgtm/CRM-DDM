# API V1 — Consulta integral de conversas (proposta)

URL: `https://omnicrm.grupoddm.ia.br`

**Status:** em revisão; não publicar até validação do PR. Exige chave de conta com `conversations:read` (diferente de `reports:read`).

## Listar
`GET /api/v1/conversations?from=2026-10-13&to=2026-10-13&status=open&limit=50`

Filtros: `from`, `to` (data de criação; Brasília), `status`, `agent_id`, `team_id`, `channel_type`, `limit`, `cursor`. Ordenado por `created_at,id` ascendente. Resposta: `{ "data": { "items": [ ... ], "next_cursor": "..." } }`.

## Histórico completo
`GET /api/v1/conversations/{id}/messages?limit=100&cursor=...`

Retorna mensagens de todo o histórico, **em páginas**, não apenas a última. Inclui `sender_type` (IA/bot, operador ou cliente), conteúdo, tipo, metadados de mídia, template e timestamps. Seguir `next_cursor` até `null` para obter tudo. O campo `media_url` **não é garantia de acesso público**; URLs privadas podem exigir fluxo autenticado de mídia.

## Lote
`POST /api/v1/conversations/messages/batch`

```json
{
  "conversation_ids": ["11111111-1111-4111-8111-111111111111"],
  "limit": 100,
  "cursors": {}
}
```

Até 20 conversas por lote, até 100 mensagens por conversa e até 2.000 mensagens na resposta. Cada entrada tem `conversation_id`, `items` e `next_cursor`. Iterar o cursor por conversa, independentemente, para acessar o histórico integral.

## Segurança e limitações
- Chave `conversations:read` dá acesso aos históricos daquela conta. Restrinja a pessoal autorizado e integração em backend.
- Serviço usa role administrativa; toda conversa e mensagem precisa ser filtrada por `account_id`. IDs de outra conta retornam 404.
- Não incluir CPF/documentos em logs de API; retorno pode conter dados pessoais e deve seguir política de retenção.
- A exportação assíncrona com arquivo, download e retenção **ainda não faz parte destes três endpoints**: precisa de fila/worker e armazenamento privado dedicado. Não anunciar como disponível até implementado e testado.
