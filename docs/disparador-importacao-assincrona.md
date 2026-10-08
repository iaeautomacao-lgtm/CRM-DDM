# Disparador — importação de contatos em segundo plano (contrato para o front)

PRD 11, A12/A13 · migration 197. Importar uma base de ~100 mil contatos deixa de depender de uma aba aberta mandando
blocos em sequência e de o servidor ler/parsear um arquivo inteiro no event loop. A importação vira um *job*: o navegador lê
o arquivo (como o assistente de campanha já faz), **guarda** os blocos de linhas no servidor e **libera** o job; um cron
stateless (`POST /api/disparador/imports/cron`, a cada minuto) processa os blocos em ordem, de forma retomável. Fechar a aba depois
do `start` não interrompe nada.

## Onde o caminho atual travava

| Ponto | O que acontecia com 100 mil linhas |
|---|---|
| Arquivo (`FormData`) numa requisição só | o servidor lê até 20 MB e roda `Papa.parse`/`XLSX.read` **síncrono no event loop** (bloqueia todas as requisições do processo) e processa tudo na mesma requisição → estoura o tempo do proxy |
| Blocos JSON dirigidos pelo navegador | cada bloco (≤ 10.000 linhas) é processado dentro da requisição; a importação só avança enquanto a aba está aberta; erro de rede no meio deixa a campanha com a lista pela metade e o usuário precisa saber de onde retomar |
| Falhas | só voltam na resposta do bloco; não há onde consultar depois |

O que **não mudou**: o processamento de cada bloco é a **mesma função** (`importContactBlock`, movida da rota sem alterar regra):
dedupe (CPF e telefone, com/sem 9º dígito e 55), opt-out/blacklist, tags, telefones alternativos, VAR1–VAR3 e vínculo com a
campanha/rascunho. Por isso o resultado do job é idêntico ao da importação atual (teste de equivalência com um arquivo sintético).

## Fluxo

1. `POST /api/disparador/imports` → cria o job.
2. Para cada bloco `n = 0, 1, 2…` (até 10.000 linhas): `PUT /api/disparador/imports/[id]/blocks/[n]` → guarda as linhas (rápido; reenviar o mesmo `n` substitui).
3. `POST /api/disparador/imports/[id]/start` com `{ "total_blocks": N }` → confere que todos chegaram e libera o cron.
4. `GET /api/disparador/imports/[id]` até `state = "done"` (ou `failed`).

Permissão: `campaigns.manage` (a mesma da importação atual). Um job só é visível pela conta que o criou.

## Rotas

### `POST /api/disparador/imports`
Corpo: `{ "campaign_id"?: uuid, "draft_id"?: uuid, "column_map": { "phone": "…", "name"?: "…", "cpf"?: "…", "var1"?: "…", "var2"?: "…", "var3"?: "…" }, "mapping_confirmed": true }`
(o mesmo mapeamento do assistente; `phone` e a confirmação são obrigatórios). Resposta `201` `{ "job": <job> }`.
Erros: `400` (mapeamento/ids), `404` (campanha ou rascunho de outra conta), `503` com `code: "unavailable"` (migration 197 não aplicada).

### `PUT /api/disparador/imports/[id]/blocks/[n]`
Corpo: `{ "rows": [ { "<cabeçalho>": "<valor>", … }, … ] }` — objetos cabeçalho→valor (qualquer valor vira texto). Resposta `200` `{ "job" }`.
Erros: `400` (`invalid_block`, `no_rows`, `block_too_large` > 10.000 linhas, `no_phone_column` no bloco 0), `409` (`not_receiving`: o job já foi iniciado).

### `POST /api/disparador/imports/[id]/start`
Corpo: `{ "total_blocks": N }`. `202` `{ "job" }`. `409` `blocks_missing` lista os blocos que faltam (reenvie e tente de novo).

### `GET /api/disparador/imports/[id]` · `GET /api/disparador/imports?campaign_id=&draft_id=`
`{ "job" }` / `{ "jobs": [...] }` (20 mais recentes da conta).

## Objeto `job`

| Campo | Significado |
|---|---|
| `id`, `campaign_id`, `draft_id` | identificação |
| `state` | `receiving` (aceitando blocos) · `pending` (liberado, aguardando o cron) · `running` · `done` · `failed` · `cancelled` |
| `blocks_received`, `blocks_total`, `next_block` | blocos guardados / total declarado no `start` / próximo a processar |
| `rows_total`, `rows_done`, `progress` | linhas recebidas / processadas / `0..1` |
| `totals` | `{ importados, duplicados, invalidos, blacklisted, variaveis_falhas }` — a soma dos mesmos números que a resposta síncrona dava por bloco |
| `linked` | contatos vinculados à campanha/rascunho |
| `errors` | até 200 mensagens por linha/bloco (ex.: `11999990001: não foi possível salvar o contato.`) — o "erro por linha" |
| `error` | motivo, só quando `state = "failed"` |

`variaveis_falhas > 0` continua significando "reimporte antes de iniciar a campanha" (variável vazia para esses contatos).

## Falhas e retomada

- Queda do processo/restart: o lease do job vence (2 min) e o próximo tick continua do bloco em curso; cada bloco é idempotente (reenvio do mesmo bloco não duplica contatos nem vínculos).
- Erro de banco/Storage: o job volta a `pending` com espera crescente (1, 2 min) e, na 3ª tentativa, vira `failed` com o motivo; o que já foi importado fica.
- Job `receiving` sem `start` por 24 h é cancelado e os blocos guardados são apagados.
- Observação: se o processo cair **entre** gravar um bloco e registrar o progresso, o bloco é refeito e os `totals` desse bloco contam como `duplicados` (os contatos já existiam) — os dados ficam corretos.

## Mudança na importação por arquivo

`POST /api/disparador/contacts/import` com **arquivo** (`FormData`) passa a aceitar até **20.000 linhas**. Acima disso responde `409`:

```json
{ "error": "Arquivo grande demais para importar na hora…", "code": "import_too_large", "async_endpoint": "/api/disparador/imports", "max_sync_rows": 20000 }
```

O front deve ler o arquivo no navegador e usar o fluxo acima. A importação por **blocos JSON** (`rows`, até 10.000 por requisição)
continua exatamente como é.

## Migration 197 e cron

`dispatch_import_jobs` + `claim_dispatch_import_job(owner, lease)` (reserva por job, `FOR UPDATE SKIP LOCKED`, lease). Tabela fechada
(RLS sem policy, só `service_role`); as linhas ficam no Storage (`relatorio-exports/<conta>/disparador-imports/<job>/blocks/`) e são apagadas ao concluir.
Sem a migration: as rotas novas respondem `503 unavailable` e as importações atuais seguem funcionando. Cron: ver `docs/crons.md` e `ops/crontab.example`.

## Fora deste PR

A auditoria agregada (1 linha por lote em vez de 1 por contato — R6 do PRD 11) depende do trigger de auditoria por contato e não foi alterada.
