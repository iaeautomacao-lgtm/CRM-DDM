# Disparador — painéis sem varredura da fila (contrato para o front)

PRD 11, A20/A21 · migrations 198 e 198b. O formato de resposta das rotas existentes **não mudou**; só foram **acrescentados**
campos opcionais. O front pode ignorá-los.

## `GET /api/disparador/desempenho/live`

Polling curto da tela de Desempenho. Resposta (igual a antes):

```json
{ "ok": true, "live": { "sampledAt": "…", "activeCampaigns": 2, "queued": 1200, "sending": 40, "errors": 3, "blocked": 0, "remaining": 1240, "sentLast60s": 780 } }
```

Novo, **opcional**: `live.capped` — presente **somente** quando alguma contagem bateu no teto de custo (100.000 por
contagem). Nesse caso o número mostrado daquele campo é um **mínimo** ("100.000+"):

```json
"capped": { "queued": true, "sending": false, "errors": false, "blocked": false, "sentLast60s": false }
```

Ausente = todos os números são exatos (o caso normal). Sem a migration 198 a rota usa as contagens de antes.

## `GET /api/disparador/campaigns/[id]/queue-details`

Sem mudança de formato (`{ rows, total, page, pageSize }`). O `total` agora vem de uma agregação por status (a mesma conta dos
cards de métricas) em vez de `count: exact` junto da página; busca por contato, "respondidos" e "aguardando confirmação"
continuam com contagem exata.

## Migrations

| Arquivo | O que faz | Observação |
|---|---|---|
| `198_dispatch_live_counts.sql` | RPC `dispatch_live_counts(p_account_id, p_cap)`: as cinco contagens do live numa ida só, cada uma com teto | `REVOKE` de anon/authenticated; só `service_role` |
| `198b_dispatch_queue_page_idx.sql` | índice `(campaign_id, sent_at DESC NULLS LAST, scheduled_at DESC, id)` da paginação do detalhamento | **opcional**, `CONCURRENTLY`, rodar sozinho; custo de escrita — validar na bancada |
