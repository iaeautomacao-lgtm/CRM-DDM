# Disparador — exportação assíncrona da fila (contrato para o front)

PRD 11, A22 · migration 203. Exportar a fila de uma campanha grande (até 100 mil linhas) **não roda mais dentro da
requisição**: vira um *job* processado em segundo plano por um cron stateless; o arquivo vai para o Storage e o link de
download é assinado e curto.

## Fluxo

1. `POST /api/disparador/exports` cria (ou reaproveita) o job → `202`.
2. O front consulta `GET /api/disparador/exports/[id]` até `state = "done"` (ou lista com `GET /api/disparador/exports`).
3. Pronto: `GET /api/disparador/exports/[id]?download=1` devolve um link assinado (10 min). O arquivo expira em 24 h.

Permissão: a mesma do detalhamento da campanha (`campaigns.manage`). Um job só é visível/baixável pela conta que o pediu.

## Rotas

### `POST /api/disparador/exports`
Corpo: `{ "campaign_id": "<uuid>", "status": "<métrica>" }` — `status` é a chave do modal de métricas
(`total`, `agendado`, `enviado`, `entregue`, `lido`, `erro`, `bloqueado`, `respondido`, `aguardando_confirmacao`).
Resposta `202`: `{ "job": <job> }`. Pedido idêntico já em andamento devolve o **mesmo** job (não duplica).
Erros: `400` (campanha/métrica inválidas), `404` (campanha de outra conta), `503` com `code: "unavailable"` (migration 203 não aplicada).

### `GET /api/disparador/exports?campaign_id=<uuid>`
`{ "jobs": [<job>, …] }` — os 20 mais recentes da conta (filtrável por campanha). Sem a migration: `{ "jobs": [], "unavailable": true }`.

### `GET /api/disparador/exports/[id]`
`{ "job": <job> }`. Com `?download=1`:
- `200` `{ "job", "download": { "url", "expires_in_seconds": 600 } }` — baixe a `url` direto (link assinado do Storage);
- `409` `code: "not_ready"` — ainda processando;
- `410` `code: "expired"` — o arquivo venceu; peça outra exportação;
- `404` — não existe ou é de outra conta.

### `POST /api/disparador/exports/cron` (não é do front)
Agendador externo, a cada minuto: `curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://<host>/api/disparador/exports/cron`.

## Objeto `job`

| Campo | Tipo | Significado |
|---|---|---|
| `id`, `campaign_id`, `status_key`, `format` (`"csv"`) | | identificação |
| `state` | `pending` \| `running` \| `done` \| `failed` \| `expired` \| `cancelled` | estado |
| `rows_done`, `total_rows` | número / `null` | progresso (`total_rows` é uma estimativa; `null` = desconhecido) |
| `progress` | `0..1` ou `null` | `rows_done / total_rows` |
| `truncated` | boolean | bateu no teto de 100.000 linhas: o arquivo pode estar incompleto |
| `file_size` | bytes ou `null` | tamanho do arquivo pronto |
| `created_at`, `finished_at`, `expires_at` | ISO | datas (`expires_at` só depois de pronto) |
| `error` | texto ou `null` | motivo, só quando `state = "failed"` |

## Arquivo

CSV UTF-8 com BOM, separador `;` (abre direto no Excel em português), mesmas colunas do XLSX do detalhamento
(`Contato`, `Telefone`, `Status`, `Mensagem Final`, + `Tipo de Erro` em erros, + `Motivo` em "aguardando confirmação", `Data/Hora`).
A ordem das linhas é por id do item (leitura por *keyset*); use a coluna `Data/Hora` para ordenar no Excel.
Células que começam com `=`, `@` ou `+`/`-` seguidos de não-número recebem um apóstrofo (proteção contra injeção de fórmula).

## Mudança no detalhamento síncrono

`GET /api/disparador/campaigns/[id]/queue-details?export=xlsx` continua gerando o XLSX na hora **até 10.000 linhas**.
Acima disso responde `409`:

```json
{ "error": "Exportação grande demais…", "code": "export_too_large", "async_endpoint": "/api/disparador/exports", "max_sync_rows": 10000 }
```

O front deve tratar esse código chamando `POST /api/disparador/exports` (e mostrar o progresso).

## Migration 203

`dispatch_export_jobs` + `claim_dispatch_export_job(owner, lease)` (reserva por job, `FOR UPDATE SKIP LOCKED`, lease). Tabela fechada
(RLS sem policy, só `service_role`). Sem a migration: as rotas novas respondem `503 unavailable` e o XLSX pequeno segue funcionando.
Pré-check, rollback e registro em `schema_migrations` no cabeçalho do arquivo.
