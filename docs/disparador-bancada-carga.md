# Bancada de carga do disparador (Meta simulada)

Meta do dono: o backend aguentar **80 envios/s por número** (4.800/min), vários números, picos de 100 mil — **medindo sem gastar mensagem**.
A bancada tem 4 peças, todas em `scripts/loadtest/` + um gate no app:

| Peça | O que faz |
|---|---|
| `mock-meta.mjs` | "Meta simulada": imita `POST /{versão}/{phone_number_id}/messages`, injeta falhas, devolve webhooks assinados, `/__stats` por número e por segundo |
| `seed.mjs` | Volume realista no banco de **teste**: 100k contatos, 50k na blacklist, 3M de linhas históricas na fila |
| `load.mjs` | Cria canais/template/campanhas fictícios, roda o cron em loop e imprime o relatório em tabela |
| gate no app (`src/lib/loadtest/gate.ts`) | `META_API_BASE_URL` / `OPENAI_BASE_URL` só valem com `DISPATCH_LOAD_TEST=1`; recusam o endereço real e o Supabase de produção; o app **aborta no boot** se o gate falhar |

> ⛔ **Nunca** use com canais/tokens reais, nem contra o Supabase de produção (`cyftbffhgjmsfogxawrl`). A bancada roda em **staging**:
> um app (outro serviço no EasyPanel) + um **projeto Supabase de staging** com o schema de produção (só schema, sem dados reais).
> O `/api/stress/run` **não** serve para carga (é o health check diário): a carga vem de scripts externos.

## 1. Preparar o staging

1. Projeto Supabase de staging com as migrations aplicadas (inclusive as de capacidade 164–168, 183 se já existirem).
2. App de staging com as variáveis:
   ```
   DISPATCH_LOAD_TEST=1
   META_API_BASE_URL=http://<host-do-mock>:4010      # só a origem; o app acrescenta /v21.0/…
   OPENAI_BASE_URL=http://<host-do-mock-openai>:4020  # opcional (cenário S8)
   META_TIMEOUT_MS=10000                              # igual à produção, para o "timeout" do mock ser fiel
   NEXT_PUBLIC_SUPABASE_URL=<URL do Supabase de STAGING>
   ```
   Se o gate falhar (variável sem `DISPATCH_LOAD_TEST=1`, endereço real da Meta/OpenAI, ou o ref de produção no ambiente) **o app não sobe**
   (`src/instrumentation.ts`) e o envio Meta lança erro ao carregar. Com a bancada ativa, o log mostra `⚠️⚠️⚠️ BANCADA DE CARGA ATIVA`.
3. Um **usuário e uma conta de teste** (ids em `LOAD_USER_ID` / `LOAD_ACCOUNT_ID`) e uma **chave de API** da conta com `campaigns:write`.

## 2. Subir a Meta simulada

```bash
MOCK_HOST=0.0.0.0 MOCK_PORT=4010 \
MOCK_WEBHOOK_URL=https://<app-de-staging>/api/whatsapp/webhook \
MOCK_APP_SECRET=mock-app-secret \
node scripts/loadtest/mock-meta.mjs
```

Padrão (audit §4): latência lognormal **média ≈ 0,85 s, p95 1,0 s**; falhas **1 % 5xx, 0,5 % 429/130429, 0,2 % 131056, 0,3 % 131026 assíncrono,
0,5 % timeout** (segura a conexão 12 s, acima do `META_TIMEOUT_MS`). Para cada envio aceito emite webhooks **assinados** (HMAC-SHA256 com o
`MOCK_APP_SECRET` — cadastre o mesmo valor como `app_secret` dos canais de teste): `sent` +1 s, `delivered` +3 s, `read` +30 s (60 %), `failed` 2 %,
≈ 1 % duplicados, ≈ 2 % fora de ordem; `phone_number_quality_update` periódico (`MOCK_QUALITY_INTERVAL_MS`) ou sob comando.

| Endpoint | Uso |
|---|---|
| `GET /__stats` | por `phone_number_id`: total, ok, erros por tipo, req/s do último segundo, pico, em voo, **linha do tempo dos últimos 60 s**; contadores de webhooks |
| `GET /__reset` | zera os contadores |
| `POST /__control` | muda em tempo real: `{"latencyP50Ms":..,"errorRates":{"429":0.2},"phoneLatency":{"<phone_id>":{"p50":3000,"p95":3500}},"quality":{"phone":"<phone_id>","event":"FLAGGED"}}` |

Variáveis do mock: `MOCK_PORT`, `MOCK_HOST`, `MOCK_LATENCY_P50_MS`, `MOCK_LATENCY_P95_MS`, `MOCK_ERRORS` (`5xx=0.01,429=0.005,131056=0.002,async_131026=0.003,timeout=0.005`),
`MOCK_TIMEOUT_HOLD_MS`, `MOCK_QUALITY_INTERVAL_MS`, `MOCK_WEBHOOK_URL`, `MOCK_APP_SECRET`, `MOCK_WABA_ID`, `MOCK_READ_RATE`.

## 3. Volume (seed) e execução

Crie `.env.load` na raiz (não é o `.env` do app; **não vai para o git**):

```
LOAD_SUPABASE_URL=https://<projeto-de-staging>.supabase.co
LOAD_SUPABASE_SERVICE_ROLE_KEY=<service role do STAGING>
LOAD_ACCOUNT_ID=<uuid da conta de teste>
LOAD_USER_ID=<uuid do usuário de teste>
LOAD_APP_URL=https://<app-de-staging>          # remoto? então LOAD_ALLOW_REMOTE_APP=true
LOAD_ALLOW_REMOTE_APP=true
LOAD_CRON_SECRET=<CRON_SECRET do app de staging>
LOAD_API_KEY=<chave da conta de teste com campaigns:write>
LOAD_MOCK_STATS_URL=http://<host-do-mock>:4010
LOAD_CONFIRM_TEST_DB=yes                      # "sim, este banco é de TESTE"
ENCRYPTION_KEY=<a MESMA do app de staging>     # o script cifra o token/segredo dos canais fictícios
```

```bash
npx tsx scripts/loadtest/seed.mjs                       # 100k contatos, 50k blacklist, 3M histórico (demora; --contacts/--blacklist/--history ajustam)
LOAD_CHANNELS=1 LOAD_ITEMS=20000 npx tsx scripts/loadtest/load.mjs        # S3: 1 número, ~80/s
LOAD_CHANNELS=4 LOAD_ITEMS=20000 LOAD_CAMPAIGNS_PER_CHANNEL=3 npx tsx scripts/loadtest/load.mjs   # S4: 4 números, várias campanhas
npx tsx scripts/loadtest/load.mjs --cleanup LOAD<id>    # apaga o que uma execução criou
npx tsx scripts/loadtest/seed.mjs --cleanup             # apaga o seed
```

O script **recusa** rodar se `LOAD_SUPABASE_URL` contiver o ref de produção, sem `LOAD_CONFIRM_TEST_DB=yes`, ou com app fora de localhost/rede privada sem
`LOAD_ALLOW_REMOTE_APP=true`. Limites: `LOAD_CHANNELS` (1–50), `LOAD_ITEMS` (1–20 000 por campanha), `LOAD_DURATION_S`, `LOAD_TICK_INTERVAL_MS`.

**Relatório (tabelas):** por número — requisições, média/s, pico/s, máximo em voo, erros; do tick — p50/p95/máx da duração (`cron_tick`), p50/p95 da resposta
HTTP do cron, enviados/falhas, em voo (pico), **lag do event loop p99**, **RSS pico**, eventos de backoff, erros do provedor; e a fila final por status.
**Idas ao banco por envio:** rode `SELECT sum(calls) FROM pg_stat_statements;` no projeto de teste antes e depois; (delta ÷ envios) = idas por envio.

## 4. Roteiro S0–S11 (30–60 min cada)

| # | Cenário | Como rodar | Mede | Aceite |
|---|---|---|---|---|
| S0 | Calibração do mock | mock sozinho + `load.mjs --setup-only`/envios; `/__stats` e a latência observada | latência/erros injetados | p95 1,0 s ±10 % |
| S1 | Linha de base: 1 número, 50k Imediato, config atual | `LOAD_CHANNELS=1 LOAD_ITEMS=20000` (3 campanhas p/ 50k) | envios/min, p95 do claim | reproduz ~480/min (valida o mock) |
| S2 | Degraus 12→24→48→**100** vagas (tetos elevados) | repetir S1 variando a concorrência (envs de throughput) | envios/min, lag p99, RSS, CPU Node e Postgres | ≥ 2.000/min na F1 sem lote; escala linear até o teto |
| **S3** | **80/s em 1 número (≈ 4.800/min)**, tick encadeado, lotes, token bucket | `LOAD_CHANNELS=1 LOAD_ITEMS=20000` | envios/min, atraso sent→status aplicado, CPU | **F1: ≥ 4.500/min sustentado**, lag p99 < 100 ms |
| S4 | 4 números × 20/s, 3 campanhas por número; 1 número com latência 3 s | `LOAD_CHANNELS=4 LOAD_CAMPAIGNS_PER_CHANNEL=3` + `POST /__control` `phoneLatency` num número | justiça entre campanhas; número lento não derruba os outros | campanhas pequenas terminam em minutos |
| S5 | Rajada 08:00: agendada de 50k + outras rodando | agendar campanha para o minuto seguinte (`janela_inicio`) + S4 | preparação, ticks perdidos, `already_running` | zero tick perdido |
| S6 | Import CSV/XLSX 50k e 100k | pela tela de importação do staging (ver `route.load.test.ts`) | tempo, RSS, 5xx, auditoria | 100k < 5 min sem 5xx |
| **S7** | **Webhooks 125 → 250 → 500 eventos/s por 15 min** (1 % dup., 2 % fora de ordem) | mock com `MOCK_WEBHOOK_URL`; subir o número de números/campanhas | p99 até o 200, lag p99, req/s PostgREST, deadlocks | 200 p99 < 300 ms; lag p99 < 100 ms; 0 deadlock; backlog do inbox < 30 s |
| S8 | Onda de respostas 10 % + 429 da OpenAI | `OPENAI_BASE_URL` → mock da OpenAI (a escrever) + respostas via webhook | fila de IA, latência do Inbox | Inbox p95 < 800 ms |
| S9 | Reiniciar o container no meio do S3/S7 | reiniciar o app de staging durante a carga | itens `enviando` presos, eventos perdidos | **zero evento de status perdido**; recuperação ≤ 30 min (≤ 2 min p/ lock TTL 90 s) |
| S10 | Duplicidade | SQL: `count(*)` por `waha_message_id` e por `(campaign_id, contact_id, template)` | duplicados | **0** |
| S11 | Qualidade GREEN→YELLOW→RED no mock | `POST /__control {"quality":{"phone":"…","event":"FLAGGED"}}` | tempo até o limite/s cair, aviso no Monitor | ≤ 1 tick; histórico gravado |

**Coleta (SQL do projeto de teste):** `system_logs` `event='cron_tick'`, `wacrm.dispatch_throughput_per_minute`, `pg_stat_statements` (top `total_exec_time`),
`pg_stat_activity` (wait events — multixact), `pg_stat_user_tables.n_dead_tup` de `campaign_metrics`/fila, `pg_stat_database.deadlocks`, `docker stats` por serviço.
**Critérios F1:** ≥ 2.000 envios/min (≥ 4.500 no S3); event loop p99 < 100 ms; RSS < 60 % do limite do container; Inbox p95 < 800 ms; webhook p99 até o 200 < 300 ms;
CPU do Supabase < 70 %; claim p95 < 10 ms; zero duplicado; zero tick perdido; zero recibo órfão após cleanup.

## 5. Segurança — resumo

- `META_API_BASE_URL` / `OPENAI_BASE_URL`: **só com `DISPATCH_LOAD_TEST=1`**; recusam `*.facebook.com` / `*.openai.com`, URL com usuário/senha e inválida; com o gate ligado, recusam
  também `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_URL` com o ref de produção (`LOADTEST_FORBIDDEN_SUPABASE_REFS`, em `gate.ts` e `scripts/loadtest/lib/forbidden.mjs` — um teste garante que são iguais).
- Falha do gate = **o app não sobe** (boot) e `meta-api.ts` lança ao carregar. Em produção **não** defina nenhuma dessas variáveis.
- O mock só escuta em `127.0.0.1` por padrão (`MOCK_HOST=0.0.0.0` só em rede privada de staging). Tokens e `app_secret` dos canais de teste são fictícios.
- Os scripts nunca leem o `.env` do app; só `.env.load`/variáveis `LOAD_*` explícitas.

## 6. Roteiro passo a passo para o dono (S1–S3, S9–S10) e a decisão de ligar o lote

Decisão do dono de 13/10 (item 1): **medir na bancada antes de ligar** o envio em lote e o tick encadeado. Nada disso está ligado agora
(`DISPARADOR_BATCH_CLAIM` e `DISPARADOR_TICK_CHAIN` ausentes = desligados). Este roteiro é o que **você** roda; não há staging nem Meta real envolvidos
(a Meta é o mock) e nenhuma mensagem é gasta. Reserve ~3 horas e uma máquina que **não** seja a de produção.

> ⚠️ Em todos os passos: se o terminal pedir `LOAD_CONFIRM_TEST_DB=yes`, só responda sim se a URL for a do projeto de **staging**. Se aparecer
> `cyftbffhgjmsfogxawrl` em qualquer variável, **pare**: é produção.

### 6.1 Antes de começar (uma vez)

1. Siga as seções 1 a 3: projeto Supabase de staging com as migrations aplicadas (inclusive 164–168, 183, 332–338), app de staging com `DISPATCH_LOAD_TEST=1`
   e `META_API_BASE_URL` apontando para o mock, mock no ar (`node scripts/loadtest/mock-meta.mjs`), `.env.load` preenchido.
2. Confira que o app de staging subiu com o aviso `⚠️⚠️⚠️ BANCADA DE CARGA ATIVA` no log. Sem o aviso, não rode nada.
3. Rode o seed: `npx tsx scripts/loadtest/seed.mjs` (demora; só uma vez).
4. Em cada cenário, antes de começar: `curl http://<host-do-mock>:4010/__reset` (zera contadores) e anote o horário. Ao terminar, guarde a saída do `load.mjs`
   e o resultado de `curl http://<host-do-mock>:4010/__stats`.
5. Capacidade do app de staging para S2/S3 (valores do `docs/disparador-tick-encadeado.md`): `DISPATCH_PROCESS_CONCURRENCY=150` e
   `DISPARADOR_PER_NUMBER_CONCURRENCY_META=100`.

### 6.2 S1: linha de base (confere se o mock reproduz a produção)

1. Com **lote e encadeamento desligados**: `LOAD_CHANNELS=1 LOAD_ITEMS=20000 npx tsx scripts/loadtest/load.mjs`.
2. Leia a tabela final: **envios/min** e **p95 do claim**.
3. ✅ Aceite: cerca de **480 envios/min**. Se der muito diferente, o mock ou o staging está fora do padrão: **não siga**; avise a Âncora com a saída.

### 6.3 S2: degraus de vagas (acha o teto sem lote)

1. Repita o S1 quatro vezes, mudando `DISPARADOR_PER_NUMBER_CONCURRENCY_META` no app de staging (reinicie o app a cada mudança): **12, 24, 48, 100**.
2. Anote, por degrau: envios/min, lag do event loop p99, RSS e CPU (Node e Postgres: `docker stats` e o painel do Supabase).
3. ✅ Aceite: chega a **2.000 envios/min ou mais sem lote** e cresce de forma proporcional até o teto. Se parar de crescer antes de 2.000, anote em que degrau.

### 6.4 S3: 80/s em 1 número (o teste que decide o lote)

Rode **duas vezes**, com o mesmo comando (`LOAD_CHANNELS=1 LOAD_ITEMS=20000 npx tsx scripts/loadtest/load.mjs`):

| Rodada | App de staging com | Para quê |
|---|---|---|
| A | `DISPARADOR_TICK_CHAIN=1` (sem lote) | ver quanto o encadeamento sozinho rende |
| B | `DISPARADOR_TICK_CHAIN=1` **e** `DISPARADOR_BATCH_CLAIM=1` | ver quanto o lote soma |

Reinicie o app entre as rodadas. Em cada uma anote: **envios/min sustentado**, **atraso do envio até o status aplicado**, **lag p99**, **CPU do Supabase** e
**RSS**.

✅ Aceite da rodada: **4.500 envios/min ou mais sustentado**, lag p99 **abaixo de 100 ms**, RSS **abaixo de 60 %** do limite do container, CPU do Supabase
**abaixo de 70 %**, claim p95 **abaixo de 10 ms**.

### 6.5 S9: reiniciar no meio da carga

1. Comece uma rodada do S3 (a que passou no aceite; se nenhuma passou, a A).
2. Com a carga em andamento (uns 5 minutos depois do início), **reinicie o container do app de staging** (EasyPanel → Reiniciar).
3. Espere a campanha terminar. Depois consulte no banco de staging:
   ```sql
   select status, count(*) from wacrm.disp_message_queue where campaign_id in (<ids da execução>) group by 1;
   ```
4. ✅ Aceite: **nenhum item preso em `enviando`** depois de ~2 minutos (o lock vence em 90 s) e **nenhum evento de status perdido** (o total de
   `sent` no `/__stats` do mock bate com o de itens enviados + falhas na fila).

### 6.6 S10: duplicidade (a prova de que nada saiu duas vezes)

Depois do S9 (e de cada rodada do S3), no banco de staging:

```sql
-- por mensagem do provedor
select waha_message_id, count(*) from wacrm.disp_message_queue
 where waha_message_id is not null group by 1 having count(*) > 1;
-- por campanha, contato e template
select campaign_id, contact_id, count(*) from wacrm.disp_message_queue
 where status in ('enviado','entregue','lido') group by 1, 2 having count(*) > 1;
```

✅ Aceite: as duas consultas devolvem **0 linhas**. Qualquer linha: **não ligue nada** e mande a consulta e a saída para a Âncora.

### 6.7 Decisão: ligar o lote em produção?

| Resultado | Decisão |
|---|---|
| S1 a S3 e S9/S10 dentro do aceite com a **rodada B** | Pode ligar o lote **e** o encadeamento |
| Rodada **A** passa (4.500/min) e a B não melhora ou piora | Ligue **só o encadeamento**; deixe o lote desligado |
| Nenhuma rodada chega a 4.500/min | Não ligue; mande a tabela para a Âncora (o gargalo é o próximo passo) |
| S9 ou S10 falharam em qualquer rodada | **Não ligue nada**, mande a saída |

Como ligar (em produção, só depois da decisão acima): hoje os dois são **variáveis de ambiente** do serviço (`DISPARADOR_TICK_CHAIN=1` e
`DISPARADOR_BATCH_CLAIM=1`, com `DISPARADOR_CHAIN_URL=http://127.0.0.1:3000` se o proxy cortar). A **chave na tela de admin** que você pediu **ainda não
existe**: falta uma entrega de backend (flag por conta no banco) e a tela. Até lá, a ligação é por variável e um reinício controlado, fora de campanha em curso.
Para desligar de novo é só remover a variável e reiniciar.

## 7. Bancada LOCAL do worker de envio (W4) — Meta simulada, sem Supabase

Para o worker (`docs/disparador-worker.md`) não há staging pago: a V2 está no Supabase Free. A bancada local roda tudo na própria máquina, **sem rede externa, sem Supabase e sem mensagem real**
(o cliente HTTP só aceita `127.0.0.1`; o ambiente dos processos é montado do zero, então `DISPARADOR_BATCH_CLAIM` e `DISPARADOR_TICK_CHAIN` nunca são herdados).

```bash
BENCH_DB=memory BENCH_NUMBERS=4 BENCH_WORKERS=1 BENCH_RATE=80 npm run bench:worker
```

| Peça | O quê |
|---|---|
| `scripts/loadtest/worker-bench/run.ts` | orquestra: banco, Meta simulada, N processos worker; imprime e grava `dist/worker-bench/<data>.{md,json}` |
| `db-host.mjs` | banco em processo próprio, por socket local. `BENCH_DB=pglite` (padrão): SQL real das migrations 118…368 em PGlite. `BENCH_DB=memory`: as mesmas RPCs em JS, sem custo de banco |
| `mock-host.mjs` | a Meta simulada de `scripts/loadtest/lib/meta-mock.mjs` (latência lognormal p50 850/p95 1000 ms, 1 % 5xx, 0,5 % 429, 0,2 % 131056, 0,5 % timeout) + CPU e atraso do laço de eventos dela |
| `worker-proc.ts` | um worker: leases com fencing, planejamento por fichas, agendador por número, `ChannelClaimer` (claim em lote com balde), `ConfirmBatcher` e `fetch` real. **Não** inclui `processQueueItem` (template, decifrar token, PostgREST/TLS): a CPU medida é um **piso** |

Variáveis: `BENCH_NUMBERS` (20), `BENCH_WORKERS` (⌈números/4⌉), `BENCH_RATE` (80/s), `BENCH_DURATION_S` (60), `BENCH_WARMUP_S` (10), `BENCH_ROUND_MS` (20000), `BENCH_LATENCY_P50_MS`/`P95_MS`,
`BENCH_ERRORS` (`none` = sem falhas), `BENCH_SLOW_NUMBERS` (números com 3 s de latência), `BENCH_QUIET_PCT` (espera a máquina ficar abaixo desse uso), `BENCH_PRIORITY=above`,
`BENCH_BARRIER=1` (reproduz o comportamento ANTIGO, com barreira por rodada, para comparar).

### 7.1 O que a bancada mede

Envios iniciados/s por número e agregado (o que a Meta recebe), justiça (índice de Jain, menor ÷ maior, menor ÷ meta, pior trecho de 5 s), p50/p95/p99 do claim e da confirmação,
tempo de serviço de cada RPC no banco, CPU (núcleos usados e ms por envio), RSS, atraso do laço de eventos, uso total da máquina na janela e quantos números a 80/s cabem por núcleo
(extrapolação linear do custo de CPU por envio).

### 7.2 O que achou e foi corrigido (barreira da rodada)

Antes, a rodada do worker esperava o **último** envio em voo: um timeout da Meta (10 s) segurava todos os números do processo, e a cauda de uma rodada ocupava vagas no banco de
forma que o claim da rodada seguinte voltava `empty` e esgotava o número até o fim da rodada. Agora (`src/worker/dispatch-worker.ts`, `src/lib/disparador/batch-claim.ts`):

- um estágio de envio **por número**: a rodada só espera o orçamento de início; a cauda em voo termina em segundo plano e **não segura** o planejamento seguinte nem os outros números;
- o limite de envios em voo por número continua valendo no banco (`max_in_flight` no claim), inclusive entre caudas e rodadas; o timeout da Meta continua respeitado;
- no modo worker, claim vazio é **transitório** (pausa de 300 ms e nova sondagem), não "esgotado"; o cron mantém o comportamento de sempre.

Medido (Meta simulada com **0,5 % de timeout**, 40 envios/s por número, banco em memória, 40 s medidos):

| Números | Antes (barreira) | Depois | Pior trecho de 5 s (depois) |
|---:|---:|---:|---:|
| 2 | 74,9 % da meta (pior trecho 0) | **100,0 %** | 39 envios/s |
| 4 | 68,6 % da meta (pior trecho 0) | **98,1 %** (menor número 97,2 % da taxa) | 30 envios/s |

Testes: `src/worker/dispatch-worker.test.ts` ("um envio preso em UM número não segura a rodada nem o outro número") e `src/lib/disparador/batch-claim.test.ts` ("empty no modo worker é transitório").
A bancada reimplementa o laço por número (não roda o `DispatchWorker`, que depende do PostgREST); o teste unitário cobre o código real.

### 7.3 Resultados parciais (esta máquina é compartilhada)

Máquina: notebook i5-1334U (10 núcleos, 12 lógicos), ~1 GB de RAM livre e **73–87 % de CPU ocupada por outros processos** durante todas as rodadas (outros agentes rodando `tsc`/testes).
As medidas abaixo são do **código anterior à correção** (barreira), banco em memória, 0,5 % de timeout, 30 s medidos, salvo indicação.

| Números × taxa | Processos | Vazão | % da meta | Justiça (Jain) | CPU/envio | Observação |
|---|---:|---:|---:|---:|---:|---|
| 2 × 80/s | 1 | 114/s | 71 % | 1,000 | 4,6 ms | cauda de timeout segura a rodada |
| 4 × 80/s | 1 | 214/s | 67 % | 1,000 | 3,8 ms | idem |
| 8 × 80/s | 2 | 525/s | 82 % | 0,998 | 2,9 ms | sem timeout injetado |
| 12 × 80/s | 3 | 367/s | 38 % | 0,993 | 4,0 ms | máquina 79 % ocupada; mock com lag p99 de 413 ms |
| **20 × 80/s** | 5 | **não medido** | — | — | — | **não medido por limitação da máquina (memória/CPU disputadas)**: melhor tentativa 24 % da meta, com 84 % da CPU tomada por outros processos, lag do worker de 400 ms a 1,7 s e timeouts causados pelo próprio mock engasgado |

Leitura honesta:

- **Custo de CPU do worker: 3–5 ms por envio** (piso, sem `processQueueItem`), o que dá **cerca de 2 a 3 números a 80/s por núcleo com 70 % de uso**. Para 20 números, planeje **≥ 8 núcleos só de worker**, mais TLS da Meta real e o `processQueueItem`. O teto global de 400 vagas por processo comporta ~4 números a 80/s (≈ 96 vagas cada).
- Com 4 números por processo o atraso p99 do laço de eventos ficou entre 60 e 300 ms (acima do critério de 100 ms) **nesta máquina disputada**; num núcleo dedicado tende a cair. Reavalie na máquina dedicada antes de fixar `DISPATCH_WORKER_MAX_NUMBERS`.
- Nenhuma rodada teve item duplicado, lease perdido ou confirmação com erro.
- **PGlite não é medida de banco.** Smoke com 2 números × 20/s: claim com p50 de 47 ms de serviço e banco 95 % ocupado, ou seja, o PGlite (WASM, uma conexão) satura antes do worker. Use `BENCH_DB=pglite` para provar o **SQL** (claim, fencing, balde, confirmação); **para saber se o banco aguenta, use Postgres real** (7.4). O modo `memory` mostra só o custo do worker.

### 7.4 Receita para a máquina dedicada (KVM) — onde o 20 × 80 deve ser medido

1. Máquina sem outras cargas (KVM 4 ou 8 da Hostinger, Node 20+, `npm ci`), `git checkout` da v2. Confirme `nproc` e RAM livre ≥ 4 GB.
2. Rode só a bancada nela (nenhum build/teste junto). `BENCH_QUIET_PCT=20` faz a bancada esperar a máquina ociosa.
3. Degraus, 60 s medidos cada; guarde os `.md`/`.json` de `dist/worker-bench/`:
   ```bash
   export BENCH_DB=memory BENCH_DURATION_S=60 BENCH_WARMUP_S=10 BENCH_QUIET_PCT=20
   BENCH_NUMBERS=4  BENCH_WORKERS=1 npm run bench:worker
   BENCH_NUMBERS=8  BENCH_WORKERS=2 npm run bench:worker
   BENCH_NUMBERS=20 BENCH_WORKERS=5 npm run bench:worker     # a meta: 1.600 envios/s
   BENCH_NUMBERS=20 BENCH_WORKERS=10 npm run bench:worker    # 2 números por processo (padrão do worker)
   BENCH_NUMBERS=8 BENCH_WORKERS=2 BENCH_SLOW_NUMBERS=2 npm run bench:worker   # número lento (3 s) não derruba os outros
   BENCH_NUMBERS=4 BENCH_WORKERS=1 BENCH_BARRIER=1 npm run bench:worker        # só para comparar com o comportamento antigo
   ```
4. **Aceite:** vazão agregada ≥ 95 % de `números × 80`, menor número ≥ 90 % da taxa, zero duplicado, zero lease perdido, atraso p99 do laço de eventos < 100 ms, RSS < 60 % do limite do processo.
5. O banco **não** é medido aqui. Para o claim p95 < 10 ms e a ocupação do banco, rode os roteiros S3/S9/S10 (seção 6) contra um Postgres real de staging com o worker de verdade (`dist/dispatch-worker.cjs`); se os 20 números não couberem por núcleo, ajuste `DISPATCH_WORKER_MAX_NUMBERS` só depois de ver o atraso do laço de eventos.
