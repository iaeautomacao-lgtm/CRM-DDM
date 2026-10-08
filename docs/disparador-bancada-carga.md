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
