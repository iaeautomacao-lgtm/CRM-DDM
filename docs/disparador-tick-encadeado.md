# Disparador — tetos 150, tick encadeado e conexão reaproveitada (P1-3a)

Meta: **80 envios/s por número**. Três mudanças no motor (`/api/disparador/cron`) e duas proteções.

## 1. Tetos 50 → 150 (migration 186)

- `MAX_PER_NUMBER_CONCURRENCY` e `MAX_DISPATCH_PROCESS_CONCURRENCY` = **150**; fora da faixa há **clamp com aviso** (nunca volta para 4).
- **WAHA** mantém teto próprio de **50** (risco de banimento): o aumento vale só para a Meta.
- Migration `186_dispatch_max_in_flight_150.sql` (aplicar **antes** do deploy; rodar o PRÉ-CHECK do cabeçalho): CHECK de `dispatch_channel_limits.max_in_flight` → `1..150` e a faixa do padrão em `claim_dispatch_item_capped`.
- Para usar: `DISPATCH_PROCESS_CONCURRENCY=150` e `DISPARADOR_PER_NUMBER_CONCURRENCY_META=100` (ou `max_in_flight` por número na tabela). Com ~1 s de latência da Meta, 80/s pedem ~80–100 em voo por número.

## 2. Tick encadeado (desligado por padrão)

`DISPARADOR_TICK_CHAIN=1` liga. Ao terminar um tick **que processou trabalho** (o lock já foi liberado), o cron dispara via `after()` um POST ao próprio `/api/disparador/cron` com o mesmo `x-cron-secret` (+ `x-cron-hop` / `x-cron-chain-start`). O hop encadeado responde **202 na hora** e roda o tick em `after()`; o **cron externo de 60 s continua** como ressuscitador (hop 0, síncrono).

| Variável | Padrão | O que faz |
|---|---|---|
| `DISPARADOR_TICK_CHAIN` | desligado | liga o encadeamento (e sobe o orçamento do tick para **50 s**, se `DISPARADOR_TICK_BUDGET_MS` não for definido) |
| `DISPARADOR_CHAIN_URL` | `NEXT_PUBLIC_APP_URL` | origem usada para chamar o próprio cron (ex.: `http://127.0.0.1:3000` evita o proxy) |
| `DISPARADOR_TICK_CHAIN_MAX_PER_MIN` | 6 | máx. de hops por minuto desde o início da cadeia |
| `DISPARADOR_TICK_CHAIN_MAX_HOPS` | 90 | máx. de hops por cadeia (depois, o cron externo recomeça) |
| `DISPARADOR_TICK_CHAIN_MAINTENANCE_EVERY` | 5 | manutenção pesada (reconcile de recibos, outbox, watchdog, preparo, limpeza) só no hop 0 e a cada N hops |

Proteções: tick ocioso (nada vencido) **encerra** a cadeia; o lock `disparador_cron` (TTL 90 s, migration 184) garante que **nunca rodam dois ticks juntos** — um hop que chega com o lock tomado devolve `already_running` e não encadeia. Retry, 131026, métricas e movimentação de itens já têm locks próprios com TTL.

**Requisito de infraestrutura:** o hop do cron **externo** é uma requisição síncrona de até ~55 s (orçamento 50 s + fechamento). O proxy do EasyPanel/Passenger precisa de **timeout ≥ 60 s** para essa rota. Os hops encadeados não dependem disso (respondem 202).

## 3. Conexão reaproveitada com a Meta

`undici` (dependência direta) com `Agent({ connections: 128, keepAliveTimeout: 30_000, pipelining: 1 })` como `dispatcher` **só** nas chamadas à Meta (`meta-api.ts`, via `meta-dispatcher.ts`) — inclusive quando `META_API_BASE_URL` aponta para a Meta simulada da bancada. WAHA, OpenAI e demais destinos não usam esse Agent (há teste que garante).

## 4. Freio do event loop com histerese (F11)

O corte das vagas por lag/RSS agora exige **3 janelas seguidas** acima do limite (um pico isolado de GC não corta), nunca desce abaixo de **25%** das vagas iniciais e **recupera dentro do tick** (devolve metade das vagas cortadas a cada 3 janelas saudáveis; evento `recovered` na telemetria).

## 5. Rate limit não consome tentativa (F8)

`130429`, `131048` e `131056` reagendam o item **sem incrementar `tentativas`** (e não viram erro permanente na última tentativa): o número saturado é desacelerado pelo cooldown/backoff, não punindo o item. Os outros erros transitórios continuam consumindo tentativa.
