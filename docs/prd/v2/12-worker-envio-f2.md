# PRD 12 — Worker dedicado de envio (F2) e ingestão de webhook separada (V2 backend)

> Base verificada: `origin/v2` @ `4fbbbfe` (worktree `wt-ancora-prd12`). Fontes: DISP-AUDIT §1–§4 (`wt-codex-DISP-AUDIT.md`), PRD 11 (disparador e filas) e o código atual. Só backend; o front recebe o contrato da seção 8.
> **Decisão do dono:** o worker entra na V2 (implementação), **validado na bancada antes** de tocar produção. Nada aqui muda `limite_por_hora`, a truncagem do engine nem `hasRunLeftNodeSnapshot`. Retenção de dados está fora.
> Legenda: **(medido)** = número de produção; **(estimativa)** = derivado do código/da auditoria, a confirmar na bancada; **A confirmar** = depende do live/EasyPanel/Supabase, o repositório não prova.

## 1. Resumo
- **Problema:** o envio roda dentro do app Next (um processo Node que também atende Inbox, UI e webhooks). Há um lock global para o tick (`cron/route.ts:355-360`), então **réplicas do app não somam vazão**, e Node é single-thread: 4 vCPU do KVM só ajudam com **vários processos**. A F1 (já na `v2`: tetos 150, tick encadeado, claim/confirmação em lote, inbox de status, limite/s por qualidade) deve levar **1 número a 80/s**; vários números a 80/s no mesmo processo não cabem (estimativa: ~2 números só com webhook+envio, `DISP-AUDIT B2 §1.4`).
- **Objetivo:** serviço(s) separados no EasyPanel (mesma imagem, comando próprio) com **lease por número no banco**, **limitador de taxa no banco** (leaky bucket, vale para vários processos), parada limpa (SIGTERM), **convivência com o cron atual** (flag + migração gradual por número, volta ao cron em segundos) e, só se a bancada pedir, **ingestão de webhook em serviço próprio** e **pooler (Supavisor)**.
- **Ganho esperado (estimativa):** de ~1 número a 80/s (F1) para **N × 4.800/min** (um worker por número ou por 2 números), com o Inbox/UI sem disputa de CPU com o envio. O teto passa a ser Meta (portfólio, qualidade, 130429) e Supabase.
- **Garantia mantida:** **at-most-once** — nunca reenviar item de resultado incerto; a exclusão entre processos continua no claim atômico do banco; o worker só adiciona exclusão por número (lease) e limite/s (bucket).
- **Condição para ligar em produção:** critérios da seção 9.8, medidos em staging com **Meta simulada** (S2/S3/S7/S9 + os novos S12–S15).

## 2. Estado atual (com arquivo:linha)

### 2.1 O que a F1 já entregou na `v2` (e o worker reaproveita)
| Peça | Onde | Observação |
|---|---|---|
| Lock global do tick (TTL 90 s, heartbeat 20 s) | `cron/route.ts:355-372`, migration `184:67-117` | só **um** tick por vez no cluster |
| Tick encadeado (`DISPARADOR_TICK_CHAIN=1`, desligado) | `tick-chain.ts:35-38,122-150`, `cron/route.ts:789-820` | hop encadeado responde 202 e roda em `after()`; cron externo de 60 s ressuscita |
| Manutenção só a cada N hops | `cron/route.ts:323,373-412,429,741-742` | reconcile de recibos, drenagem do inbox, watchdog, outbox, limpeza |
| Token bucket **em memória do tick** | `dispatch-scheduler.ts:130,187-190,211-219,400-407` | bucket nasce cheio a cada tick; **não vale entre processos** |
| Limite/s efetivo (`manual ?? auto`, rampa, cooldown) | `channel-rate.ts:93-177`, `cron/route.ts:113-191` | calculado no app a cada tick; tabelas da 190 (`dispatch_channel_rate`, `190:76-92`) |
| Vagas derivadas `ceil(rate × p95 × 1,2)` | `channel-rate.ts:180-183`, `cron/route.ts:81-84,184` | `DISPARADOR_ASSUMED_P95_S` |
| Claim em lote por fichas (**desligado**: `DISPARADOR_BATCH_CLAIM=1` liga) | `batch-claim.ts:21-26,57-76,103-155`, `188:46-163` | `FOR UPDATE SKIP LOCKED`, 1 advisory lock por lote (`188:88`); lote ≤ 50 (`batch-claim.ts:19`) |
| Confirmação em micro-lote (20 itens/150 ms) | `confirm-batcher.ts:59-60,95-124`, `188:209-244` | 1 subtransação por item; falha de lote → recibo no item (`processQueue.ts:938-966`) |
| Inbox durável de status + aplicação em lote | `status-inbox.ts:102-114,134-163`, `webhook/route.ts:352-381`, `185:66-118,338-360` | 500 se a gravação falhar; drenagem `after()` ≤ 1×/s no cluster (`try_claim_status_drain`) e no cron |
| Métricas por delta | `183:86-98,112-124`, `cron/route.ts:467-491` | sem linha quente |
| Pausa/retomada sem UPDATE gigante | `184:128-231`, `cron/route.ts:492-497` | |
| Agent undici (128 conexões, keep-alive 30 s) só para a Meta | `meta-dispatcher.ts:6-14`, `meta-api.ts:37-41` | **por processo** |
| Tetos 150 (CHECK, clamp global) | `throughput-config.ts:54-56`, `concurrency.ts:34-35`, migration 186 | WAHA fica em 50 |
| Gate da bancada (`META_API_BASE_URL`/`OPENAI_BASE_URL`) | `loadtest/gate.ts:68-80`, `src/instrumentation.ts:3-7`, `docs/disparador-bancada-carga.md` | o app **não sobe** se o gate falhar |
| Mock da Meta + seed + carga | `scripts/loadtest/{mock-meta,seed,load}.mjs` | `load.mjs` roda o **cron em loop** — não exercita worker |
| Watchdog de `enviando` (2 min, nunca reenvia) | `reconcile-unknown-provider-outcomes.ts:3`, `cron/route.ts:391-411` | |
| Cooldown persistente por rate limit | `cron/route.ts:272-294`, migration 164 | metade do limite/s e das vagas |
| Poll de saúde (qualidade) | `api/disparador/health/cron/route.ts:1-60` | continua cron externo |

### 2.2 O que **não existe** (confirmado por busca): lease por número, tabela de ownership, limitador no banco, worker/entrypoint, pooler/`pg`, serviço de ingestão. `grep worker_leases|dispatch_worker|leaky|next_slot` → vazio. `worker.ts` do app é código morto desligado (`disparador/worker.ts:19-25`).

### 2.3 Infra (informada pelo dono; **A confirmar**)
Hostinger KVM 4 (4 vCPU, 16 GB), app como serviço EasyPanel, Supabase Pro. **O repositório não contém Dockerfile nem config do EasyPanel**: `.cpanel.yml:1-9` descreve deploy cPanel/Passenger (`npm run build` + `restart.txt`), `app.js:1-20` é o entrypoint Passenger (`next start` próprio). Como a imagem do app é construída no EasyPanel (Nixpacks? Dockerfile externo?) precisa ser confirmado antes da fase W1 (pergunta 1).

## 3. Problemas e riscos
| ID | Sev. | Onde | Problema | Cenário de falha | Correção |
|---|---|---|---|---|---|
| W12-01 | ALTA | `cron/route.ts:322-784` | O tick é **uma função monolítica de ~460 linhas dentro da rota** (planejamento, escolha de números, envio, auto-pause, telemetria). Não dá para chamar de fora do Next | worker copiaria a lógica e divergiria da regra (janela, `reserve_campaign_tick`, reflow, complete) | PR W0: extrair `planTick()` e `runSendStage()` para `src/lib/disparador/` sem mudar comportamento (testes `load-bench*.test.ts`, `dispatch-scheduler.test.ts` seguram) |
| W12-02 | ALTA | `dispatch-scheduler.ts:130,187-190,400-407` | Limite/s só existe na memória de **um tick**; bucket nasce cheio em cada execução | dois processos (cron + worker, ou dois workers na troca de lease) enviam cada um 80/s ⇒ 160/s no mesmo número ⇒ 130429 e queda de qualidade | leaky bucket **no banco** por número (seção 6.4) usado por todos os caminhos (cron em lote incluído) |
| W12-03 | ALTA | `cron/route.ts:355-360` | Só existe o lock global `disparador_cron`; nenhum conceito de "dono do número" | vários workers disputam o mesmo número e o cron também; ou o lock global serializa tudo | tabela de ownership + lease por número com fencing (6.2) |
| W12-04 | MÉDIA | `confirm-batcher.ts:158-168` | O handler de SIGTERM drena mas **não encerra o processo** e, depois de registrado, o Node deixa de morrer por SIGTERM | deploy/restart: o processo fica vivo até o SIGKILL do orquestrador (≈10 s no Docker); no worker, itens em voo e lote pendente ficam sem parada limpa | worker com sequência própria de shutdown (6.6); no app, `process.exit` após o drain ou remover o handler quando não houver batcher ativo |
| W12-05 | MÉDIA | `disparador/admin-client.ts:14-26`, `logger.ts:12-21` | `createClient` sem `realtime.transport`; o supabase-js 2.108.2 aborta no Node 20 sem WebSocket (o commit `0997b09` corrigiu só os **scripts**) | worker em `node:20` não sobe (`Node.js 20 detected without native WebSocket support`) | cliente do worker com transporte "falha se usado" (padrão do `0997b09`) **ou** imagem Node 22; reproduzir no 1º dia da W1 (como o app roda hoje com Node 20.19 = **A confirmar**) |
| W12-06 | MÉDIA | `batch-claim.ts:21-26` | Claim em lote está **desligado** e a exclusão entre claims concorrentes **não é provada no PGlite** (1 conexão) | ligar o worker sem prova real de `SKIP LOCKED` ⇒ risco de teto de `max_in_flight` estourado/duplicidade | S12 (concorrência real no Postgres de staging) é pré-requisito de qualquer worker |
| W12-07 | MÉDIA | `webhook/route.ts:366-381`, `cron/route.ts:383-387` | A aplicação do inbox depende de `after()` do app e dos hops de manutenção | app parado/saturado ⇒ backlog de status cresce (métricas e itens ficam em `enviado`) | aplicador no worker (loop de 1 s, `SKIP LOCKED`); app/cron viram rede de segurança |
| W12-08 | MÉDIA | `reconcile-unknown-provider-outcomes.ts:3`, `processQueue.ts:938-966` | Se um worker **morre** com N itens em voo, cada um que a Meta aceitou e não foi confirmado fica `enviando` sem recibo e o watchdog (2 min) o finaliza como **incerto** (nunca reenvia) | crash a 80/s com ~80–100 em voo ⇒ até ~100 mensagens marcadas "incertas" por número, mesmo que tenham saído | aceitar e **medir** (S9); manter lote de confirmação ≤ 150 ms; SIGTERM drena; PRD 11 (heartbeat `inflight_until`) deixa o watchdog mais fiel |
| W12-09 | MÉDIA | `webhook/route.ts:224-231`, `status-inbox.ts:15` | Webhook (HMAC, parse, ingest) roda no mesmo event loop do Inbox/UI/IA | 3–4 números a 80/s (~160 eventos/s cada) + resposta de clientes ⇒ lag do app > 100 ms | serviço de ingestão separado **só se S7 provar** que o app não aguenta (fase W5) |
| W12-10 | MÉDIA | `admin-client.ts:18-24` | Todo acesso ao banco é **PostgREST** (HTTP) via `supabase-js`; não há `pg`/pooler no projeto (`package.json`) | PostgREST do Supabase tem pool próprio limitado (**A confirmar** no painel); 11 RPC/s por número (estimativa) cabem, mas a latência soma ao ciclo | começar com PostgREST (reuso total do código); adaptador `pg`+Supavisor só se S3 mostrar p95 de RPC > 30 ms (W6) |
| W12-11 | MÉDIA | `cron/route.ts:520-538,589-601` | Passos **por campanha** (janela, cadência `reserve_campaign_tick` de campanha sequencial, reflow, `complete_dispatch_campaign`) vivem no planejamento do tick | worker e cron disputando a cadência da mesma campanha; campanha com números em modos diferentes | regra D-6: planejamento por campanha fica **no cron**; worker só **envia** (recebe campanhas já planejadas via `claim_dispatch_batch_rated`); campanha sequencial (`batch_size=1`) fica no cron na 1ª versão |
| W12-12 | BAIXA | `audit/context.ts:36-42,76-81` | Fora de uma requisição Next o ator de auditoria não é registrado (`registerAuditActor` sai calado) | escritas do worker sem `actor_source` nas auditorias | `DISPATCH_WORKER_AUDIT_SOURCE` → cliente com header `x-audit-source`/`actor-type=system` fixo |
| W12-13 | BAIXA | `meta-dispatcher.ts:6-14` | Agent de 128 conexões é por processo | 3 workers × 128 = 384 sockets para a Meta (ok) | documentar; nenhuma ação |
| W12-14 | BAIXA | `188:209-244` | 1 subtransação por item na confirmação em lote | lote > 64 itens estoura o cache de subtransações (degradação do Postgres) | manter `maxItems=20` (`confirm-batcher.ts:59`); teto duro 50 no worker |

## 4. Objetivos e não-objetivos
**Objetivos**
1. Vazão sustentada ≥ **4.500 envios/min por número** (80/s) com lag do event loop do worker p99 < 100 ms (S3) e **N números** em paralelo (S4/S2).
2. Zero envio duplicado e zero estouro de limite/s por número, mesmo na troca de dono (S12–S14).
3. Zero evento de status perdido em reinício (S9) e backlog do inbox < 30 s (S7).
4. Migrar **número a número**, com volta ao cron em ≤ 1 tick, sem deploy.
5. O Inbox/UI deixam de competir com o envio.

**Não-objetivos**
- Redis, fila externa, `pgmq`/`pg_cron` obrigatórios (opcionais, só se liberados no Pro).
- Mudar a regra de envio (bifurcação Meta × WAHA continua em `processQueue`), janela, blacklist, opt-out, `limite_por_hora`.
- WAHA no worker na 1ª versão (fica no cron: limite fixo baixo, risco de banimento — `throughput-config.ts:55-56`).
- Reescrever o motor do cron; a refatoração W0 só extrai funções.
- Retenção/limpeza de tabelas (fora do projeto).

## 5. Requisitos
### 5.1 Funcionais (critério de aceite testável)
| ID | Requisito | Aceite |
|---|---|---|
| RF-1 | Cada número tem **no máximo um dono vivo**: lease com TTL 30 s, renovado a cada 10 s; troca só após expirar ou `release` | S13: matar o worker ⇒ outro/cron assume em ≤ 45 s; nunca dois donos simultâneos (consulta `generation`) |
| RF-2 | **Fencing**: o claim confere o dono dentro da mesma transação; worker que perdeu o lease não reivindica nada | S13: congelar (SIGSTOP) o worker 40 s ⇒ ao voltar, 0 itens reivindicados com o `owner_id` antigo |
| RF-3 | **Limite/s no banco**: soma de inícios por número ≤ `rate × (janela + burst 1 s)` para qualquer combinação de processos | S14: cron + worker no mesmo número por 5 min ⇒ envios/s ≤ 1,1 × rate (medido no mock) |
| RF-4 | Worker usa o **mesmo** `processQueueItem` (Meta × WAHA bifurcado lá), blacklist/janela/mídia/IA, claim em lote e confirmação em micro-lote | teste de equivalência: mesma fila no cron e no worker ⇒ mesmos estados finais (S10) |
| RF-5 | **Failover**: dono morto ⇒ cron volta a enviar o número em ≤ 1 tick, sem duplicar | S13/S14 |
| RF-6 | **SIGTERM**: para de reivindicar, espera os envios em voo até `DISPATCH_WORKER_DRAIN_MS` (8 s), grava o lote de confirmações, libera os leases, `exit(0)` | S9: após reinício, 0 `enviando` com recibo perdido; itens em voo não terminados viram incertos pelo watchdog (contados) |
| RF-7 | **Aplicador de status**: loop de 1 s chamando `apply_dispatch_statuses(1000)`; app e cron seguem como rede de segurança | S7: backlog < 30 s a 500 ev/s |
| RF-8 | Migração gradual: `dispatch_channel_ownership(session_id, mode)`; cron **ignora** números com dono vivo; flag global desliga tudo | desligar a flag ⇒ cron envia todos no tick seguinte |
| RF-9 | Autopausa, cooldown por rate limit, freio por event loop/RSS e telemetria `cron_tick`-equivalente continuam valendo no worker | eventos `dispatch_worker_tick` com os mesmos campos de `dispatch-telemetry.ts` |
| RF-10 | Ingestão de webhook separada (opcional, W5): valida HMAC, grava no inbox, 200/500; repassa o corpo ao app quando houver mudanças que não são status | S7 com o serviço: 200 p99 < 300 ms; mensagens recebidas continuam chegando ao Inbox |

### 5.2 Não funcionais
- **Desempenho (estimativa):** por número a 80/s ≈ 4 RPC de claim + ≈ 7 RPC de confirmação + 1 de status ≈ **12 RPC/s** (vs ~640 req/s hoje no caminho por item); CPU de um worker < 70% com 1–2 números; RSS < 60% do limite do container (limite 1 GB).
- **Segurança:** segredos só em variáveis do serviço (nunca no repositório); `ENCRYPTION_KEY` necessária para decifrar tokens (`processQueue.ts:16`); role de banco dedicada só se W6; nenhuma porta pública no worker; gate da bancada roda também no boot do worker (`gate.ts:81`).
- **Observabilidade:** seção 10. **Compatibilidade:** com migrations ausentes o app/cron seguem como hoje (padrão já usado: `isMissingRpc`, `batch-claim.ts:28-30`).

## 6. Desenho proposto

### 6.1 Componentes
```
EasyPanel (KVM 4: 4 vCPU / 16 GB)                                     Supabase Pro (compute a dimensionar)
┌────────────────────────┐  cron externo 60 s (hop 0)  ┌──────────────┐
│ app (Next/Passenger)   │──POST /api/disparador/cron─▶│ Postgres      │
│  UI · API · Inbox      │  planeja campanhas, janela, │  disp_message_queue · campaign_metric_deltas
│  tick: planeja + envia │  cadência, reflow, complete │  webhook_status_inbox · dispatch_channel_rate
│  só números `cron`     │  manutenção · prepare       │  dispatch_channel_ownership  (novo)
└────────────────────────┘                             │  dispatch_worker_leases      (novo)
┌────────────────────────┐ lease/claim/confirm/status  │  dispatch_send_bucket        (novo)
│ dispatch-worker (N×)   │◀───────RPC (PostgREST)─────▶│  cron_locks · system_logs
│ mesma imagem, comando  │                             └──────────────┘
│ próprio; 1 por número  │──POST /messages (≤ rate/s, bucket no banco)──▶ Meta
│ ou grupo               │
└────────────────────────┘
┌────────────────────────┐  (opcional W5) HMAC + ingest_status_events + 200
│ webhook-ingest         │◀── Meta (webhooks) ── repassa corpo não-status ao app
└────────────────────────┘
```

### 6.2 Ownership e lease por número (migration 199)
- `wacrm.dispatch_channel_ownership(session_id uuid PK → whatsapp_config, mode text CHECK IN ('cron','worker') DEFAULT 'cron', worker_group text, updated_by uuid, updated_at, reason text)`. **Sem linha = `cron`** (comportamento atual).
- `wacrm.dispatch_worker_leases(session_id uuid PK, owner_id text NOT NULL, lease_until timestamptz NOT NULL, heartbeat_at timestamptz, generation bigint NOT NULL DEFAULT 1, stats jsonb)`.
- RPCs (SECURITY DEFINER, `search_path=''`, só `service_role`, mesmo padrão da 188):
  - `acquire_dispatch_leases(p_owner text, p_session_ids uuid[], p_ttl_seconds int DEFAULT 30) → uuid[]`: `INSERT … ON CONFLICT (session_id) DO UPDATE SET owner_id=…, lease_until=…, generation = generation+1 WHERE lease_until <= clock_timestamp() OR owner_id = p_owner RETURNING session_id` (só para números com `mode='worker'`).
  - `renew_dispatch_leases(p_owner, p_session_ids, p_ttl_seconds, p_stats jsonb) → uuid[]` (os que **ainda** são dele; o resto = perdido).
  - `release_dispatch_leases(p_owner) → int` (SIGTERM).
  - `live_worker_sessions() → uuid[]` (leases vivos; o cron lê isto em `buildChannelWork`).
- **Fencing** (RF-2): `claim_dispatch_batch_rated` (6.4) recebe `p_owner` e devolve vazio se o lease do número não for dele naquele instante, **na mesma transação** do claim.
- **Quem decide o dono:** grupo por env (`DISPATCH_WORKER_GROUP=A`) + ownership no banco. O worker só tenta os números `mode='worker' AND worker_group = A`. Mover um número = `UPDATE` (ou rota do contrato 8); vale na próxima rodada (~1 s).

### 6.3 Convivência com o cron (flag + migração gradual)
1. **Flag global** `DISPATCH_WORKER_ENABLED` (app e worker; padrão `0`). Com `0` o cron **ignora** a tabela de ownership e o worker fica ocioso (não adquire leases) — rollback total sem SQL.
2. **Por número:** `buildChannelWork` (`cron/route.ts:164-166`, onde já pula números `paused`) passa a pular também números com dono vivo (`live_worker_sessions()`); lease expirado ⇒ o cron **assume** (failover, `DISPATCH_WORKER_FAILOVER=1` padrão) e registra `dispatch_worker_fallback`.
3. **Planejamento continua no cron** (D-6): janela, `reserve_campaign_tick`, reflow, `complete_dispatch_campaign`, autopausa (`cron/route.ts:516-607`) rodam para todas as campanhas; o cron só não **envia** números de worker. O worker lê campanhas `em_execucao` e envia por `claim_dispatch_batch_rated` — como a campanha só vira `em_execucao` pelo mesmo `startCampaign`, e janela/dia/pausa são checados no claim (`188:116`), o worker repete só a checagem barata `canSendNow` (`send-window.ts`) antes de reivindicar.
4. **Campanha com números em modos diferentes** funciona (cada processo envia os seus); a rota de ownership recusa (409) mover para `worker` um número de campanha **sequencial** (`batch_size=1`) em andamento (decisão D-6).
5. **Autopausa no worker:** reaproveita `checkCampaignAutoPause` (`cron/route.ts:520,702-714`) a cada `minAttempts` envios; o cron continua avaliando a cada tick (cobertura dupla).
6. **Cooldown/rate limit:** o worker grava `dispatch_channel_cooldowns` como o cron (`cron/route.ts:272-294`) e lê o efetivo a cada rodada.

### 6.4 Limite por segundo no banco (migration 200)
Hoje o limite é por tick, em memória (W12-02). Proposta: **GCRA / leaky bucket** por número, 1 linha, 1 UPDATE por **claim em lote** (≈4/s por número), não por item.
```sql
CREATE TABLE IF NOT EXISTS wacrm.dispatch_send_bucket (
  session_id   uuid PRIMARY KEY,
  next_slot_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- p_rate vem do app (effectiveRate: manual ?? auto, rampa, cooldown) — a regra de qualidade continua só no app (channel-rate.ts).
CREATE OR REPLACE FUNCTION wacrm.reserve_send_slots(p_session_id uuid, p_n int, p_rate numeric, p_burst_seconds numeric DEFAULT 1)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_next timestamptz; v_start timestamptz; v_g int;
BEGIN
  IF p_rate IS NULL OR p_rate <= 0 THEN RETURN p_n; END IF;                 -- sem limite: comportamento atual
  INSERT INTO wacrm.dispatch_send_bucket(session_id) VALUES (p_session_id) ON CONFLICT DO NOTHING;
  SELECT next_slot_at INTO v_next FROM wacrm.dispatch_send_bucket WHERE session_id = p_session_id FOR UPDATE;
  v_start := GREATEST(v_next, v_now - make_interval(secs => p_burst_seconds));
  v_g := LEAST(p_n, floor(extract(epoch FROM (v_now - v_start)) * p_rate)::int);
  IF v_g > 0 THEN UPDATE wacrm.dispatch_send_bucket SET next_slot_at = v_start + make_interval(secs => v_g / p_rate) WHERE session_id = p_session_id; END IF;
  RETURN GREATEST(v_g, 0);
END $$;
```
- **`claim_dispatch_batch_rated(p_session_id, p_n, p_campaign_ids, p_default_max_in_flight, p_rate, p_owner)`** é um **wrapper**: confere o lease (`p_owner`), chama `reserve_send_slots`, chama o **`claim_dispatch_batch` existente** com o `p_n` concedido (preserva os patches da 192 — `paused`, e a regra de `limite_por_hora`) e **devolve o que sobrou** (`next_slot_at -= não_usados/rate`) na mesma transação. Assim a regra de claim continua num lugar só.
- O cron em modo lote (`ChannelClaimer.refill`, `batch-claim.ts:134-140`) passa a chamar a variante com rate **quando** `ratePerSecond` existir ⇒ cron e worker compartilham o mesmo balde (RF-3). O bucket em memória do scheduler (`dispatch-scheduler.ts:211-219`) fica como pacing local.
- **Estimativa de custo:** 1 linha quente por número, atualizada ~4×/s — desprezível; o advisory lock do claim (`188:88`) já serializa por número.

### 6.5 Loop do worker (`scripts/dispatch-worker.ts`, bundle `dist/dispatch-worker.cjs`)
```
boot:   assertLoadTestGate(); valida env; cliente supabase (transporte realtime "falha se usado"); Agent Meta; instala SIGTERM/SIGINT
rodada (a cada 1 s com trabalho, até 5 s ocioso; teto de 20 s por rodada):
  1. owned = acquire/renew_dispatch_leases(owner, números {mode='worker', group})   // heartbeat a cada 10 s, stats no lease
  2. channels = loadChannelWork(owned)       // mesmo código de buildChannelWork: limites, cooldown, rate efetivo, vagas derivadas, pausado
  3. campanhas = em_execucao com itens vencidos nos números owned (count_due_dispatch_items) → fichas
  4. runDispatchSchedule({ channels, shouldStop: stopping || lostLease || fim da rodada, run: processQueueItem + ChannelClaimer(rated) + ConfirmBatcher })
  5. confirmBatcher.drain(); a cada 1 s: drainStatusInbox({ limit: 1000 }); a cada 15 s: writeLog('dispatch_worker_tick')
```
- Reuso: `runDispatchSchedule`, `ChannelClaimer`, `ConfirmBatcher`, `processQueueItem`, `preloadBlacklist`, `startHealthMonitor`, `TickTelemetry` — **sem copiar lógica** (depende de W0).
- Bundle: `esbuild` (já presente como dependência transitiva do `tsx`, `package.json:95`) com alias `@→src`, `packages: 'external'`; novo script `npm run build:worker`. Alternativa descartada: `tsx` em produção (devDependency; processo mais pesado e imagem maior).
- O worker **não importa `next/*`** (varredura de imports é critério de aceite; hoje só `send-ledger.ts:2` importa `next/server` e **não** está no grafo do `processQueue`).

### 6.6 Parada limpa (SIGTERM) — `DISPATCH_WORKER_DRAIN_MS=8000`
1. `stopping=true`: nenhuma ficha nova (o scheduler já respeita `shouldStop`, `dispatch-scheduler.ts:367`).
2. `claimer.releaseLeftovers()` devolve o que foi reivindicado e não começou (`batch-claim.ts:158-170`).
3. Espera os envios em voo até 8 s (Meta tem `META_TIMEOUT_MS=10000`; os que passarem disso ficam `enviando` → watchdog em 2 min, sem reenvio).
4. `confirmBatcher.drain()` (`confirm-batcher.ts:90-93`), `release_dispatch_leases(owner)`, log `dispatch_worker_shutdown`, `process.exit(0)`.
- Docker envia SIGTERM e, passado o *grace period* (padrão 10 s), SIGKILL: manter 8 s de drain **A confirmar** se o EasyPanel permite aumentar o grace (Anexo A.2, item 7).

### 6.7 Aplicador de status e ingestão separada
- **Aplicador (W3):** no worker, loop de 1 s (`drainStatusInbox`, `status-inbox.ts:134`) sem `requireTurn` — `apply_dispatch_statuses` já usa `SKIP LOCKED` (`185:151+`), então app/cron/worker coexistem. Quando o worker estiver estável, `DISPARADOR_STATUS_DRAIN_IN_APP=0` (novo) tira o `after()` do app (`webhook/route.ts:376`); o cron mantém a rede de segurança (`cron/route.ts:383-387`).
- **Ingestão (W5, só se S7 pedir):** serviço Node mínimo (sem Next) que replica o caminho barato do webhook: limite de corpo 1 MB (`status-inbox.ts:15`), HMAC por canal com cache de 60 s (`webhook-fast-path.ts:5-46`, `decryptStoredSecret`), `extractStatusEvents` + `ingest_status_events` (1 RPC) e **200/500**. Como a Meta tem **uma** URL por app, o serviço também **repassa o corpo original e a assinatura** ao app (`/api/whatsapp/webhook`) quando há mudanças que não são status (mensagens recebidas, templates, `phone_number_quality_update`); a duplicidade de status é inofensiva (`UNIQUE(message_id,status) ON CONFLICT DO NOTHING`, `185:78,111`). Responde 200 só quando **ambos** tiverem sucesso (500 faz a Meta reenviar — idempotente).
  - Roteamento: ou a URL do webhook na Meta aponta para o domínio do serviço de ingestão (muda config no painel Meta — risco/decisão do dono, pergunta 8), ou o proxy do EasyPanel roteia `/api/whatsapp/webhook` para ele por caminho (**A confirmar** se suportado). Alternativa sem mexer na Meta: ficar com o webhook no app e investir só em CPU (W12-09 só vira ação com dado da bancada).

### 6.8 Pooler Supavisor (W6, condicional)
- **Decisão:** a 1ª versão usa **PostgREST** (zero reescrita; `admin-client.ts`). O adaptador `pg` só entra se S3 mostrar (a) p95 de RPC de claim/confirm > 30 ms, (b) erros 5xx/limite de linhas do PostgREST, ou (c) PostgREST saturado em CPU do Supabase.
- Se entrar: `DbRpc` com duas implementações (PostgREST × `pg`) atrás da mesma interface; **só** as RPCs quentes (`claim_dispatch_batch_rated`, `confirm_dispatch_items_sent`, `*_dispatch_leases`, `apply_dispatch_statuses`) usam `pg`; resto segue `supabase-js`.
- **Supavisor modo transação** (porta 6543): sem prepared statements nomeados (`prepare:false`), sem advisory lock de **sessão** (as RPCs usam `pg_advisory_xact_lock`, ok — `188:88`), `statement_timeout` por role (`ALTER ROLE dispatch_worker SET statement_timeout='15s'`), pool 3–5 conexões por worker. A conexão **direta** do Supabase é IPv6; o pooler atende IPv4 (**A confirmar** a rede do KVM). Role `dispatch_worker` LOGIN com `GRANT EXECUTE` só nas RPCs acima (migration 201; a senha é definida à mão no SQL Editor, nunca no arquivo).

### 6.9 Compute do Supabase (valores de referência da auditoria — **A confirmar no painel/doc vigente**)
| Compute | Conexões diretas / pooler (ref.) | Uso previsto |
|---|---|---|
| Micro/Small | ~60–90 / ~200–400 | bancada pequena; **insuficiente** para 80/s |
| Medium | ~120 / ~600 | 1 número a 80/s com lotes (limite) |
| **Large** | ~160 / ~800 | **1 número a 80/s** (estimativa da auditoria) |
| **XL** | ~240 / ~1.000 | N números + inbox + pooler |
- A carga que dimensiona é **escrita**: ~660 linhas/s e ~3,5 mil entradas de índice/s **por número** (estimativa, `DISP-AUDIT §1.1`). Decidir o tamanho **depois** de S3/S7 olhando `pg_stat_statements`, CPU, IO e WAL; a bancada precisa rodar num projeto de staging **com o mesmo compute** do alvo, senão os números não valem.
- Reduzir chamadas (lotes, deltas — já na F1) vale mais que subir compute; o compute não resolve linha quente (já resolvida pelos deltas, `183`).

### 6.10 Alternativas descartadas
- **Réplicas do app:** não somam vazão (lock global) e dobram webhooks/UI.
- **Worker como `setInterval` dentro do app:** viola a regra do Passenger (`worker.ts:19-25` já foi desligado por isso).
- **Escolher dono por hash de `session_id` sem tabela:** sem visibilidade, sem rollback imediato, sem fencing.
- **Rate limit só no worker (memória):** quebra na troca de dono e na convivência com o cron (W12-02).
- **Um worker por campanha:** a exclusão natural é por **número** (o limite da Meta é por número).

## 7. Dados e migrations (numeração: **199+**, pois o PRD 11 reserva 194–198)
| Migration | Conteúdo | Pré-check (cabeçalho) | Ordem | Rollback |
|---|---|---|---|---|
| 199 | `dispatch_channel_ownership`, `dispatch_worker_leases` + RPCs `acquire/renew/release_dispatch_leases`, `live_worker_sessions` + RLS/grants só `service_role` | `to_regclass('wacrm.whatsapp_config')`, `to_regprocedure('wacrm.claim_dispatch_batch(uuid,integer,uuid[],integer)')` (188) | **antes** do deploy do código | `DROP FUNCTION/TABLE` (nada referencia) |
| 200 | `dispatch_send_bucket`, `reserve_send_slots`, `claim_dispatch_batch_rated` (wrapper) | conferir `pg_get_functiondef` de `claim_dispatch_batch` (a 192 faz *patch* por regex nele; o wrapper **chama** a função, não copia) | antes | `DROP FUNCTION wacrm.claim_dispatch_batch_rated, reserve_send_slots; DROP TABLE dispatch_send_bucket` |
| 201 | (W6, opcional) role `dispatch_worker` + `GRANT EXECUTE` nas RPCs quentes; `statement_timeout` do role | existência das funções | só se W6 | `DROP ROLE` |
- Tudo `BEGIN … COMMIT`, idempotente (`IF NOT EXISTS`/`CREATE OR REPLACE`), `NOTIFY pgrst, 'reload schema'`, **aplicado à mão no SQL Editor** conferindo o schema live antes (migrations podem divergir de produção). Sem `CREATE INDEX` (as tabelas novas são pequenas: PK basta).
- **Código novo + banco antigo = inerte:** sem as RPCs, o cron/worker detectam (`isMissingRpc`, `batch-claim.ts:28-30`) e o worker **não sobe leases** (fica ocioso e loga `dispatch_worker_migration_required`).

## 8. Contrato para o frontend
Rotas existentes que o front **já consome** e **não mudam**: `/api/disparador/monitor/snapshot`, `/limits`, `/rate-limits` (+`revert-auto`, `/acknowledge`), `/health/refresh`, `/erros`, `/desempenho/*` (ver PRD 11 §8). Novas (todas `{ error, code }` no padrão estável; auditadas):
| Rota | Método | Papel | Payload → resposta |
|---|---|---|---|
| `/api/disparador/workers` | GET | admin+ | `→ { workers: [{ owner_id, group, sessions: [{ session_id, name, phone, lease_until, generation }], heartbeat_at, sent_per_s, in_flight, event_loop_lag_p99_ms, rss_mb, version, healthy }], serverTime }` (nome/telefone via `channel-label.ts`, igual às telas de Números) |
| `/api/disparador/ownership` | GET | admin+ | `→ { items: [{ session_id, name, phone, mode: 'cron'\|'worker', worker_group, lease: { alive, owner_id, lease_until } \| null, updated_at, reason }], enabled: boolean }` |
| `/api/disparador/ownership` | PUT | **owner** | `{ session_id, mode, worker_group?, reason (≥ 3) } → { ok, item }`; erros: `409 sequential_campaign_running` (campanha `batch_size=1` em andamento), `409 worker_not_ready` (migration 199 ausente ou flag desligada), `404`, `403`; grava histórico + `logAuditEvent` |
- **Monitor:** card "Workers" (healthy/lag/RSS/`sent_per_s` por worker), selo "Cron | Worker" por número na tela Números, alerta "sem heartbeat há > 60 s com campanha rodando" (lido de `/workers` + snapshot). Sem polling < 3 s.
- Nada de segredo/URL de banco sai por estas rotas.

## 9. Testes, bancada e aceite

### 9.1 Pré-requisitos da bancada (staging)
- **Projeto Supabase de staging com o mesmo compute do alvo** + schema de produção (só schema); app de staging (serviço EasyPanel) com `DISPATCH_LOAD_TEST=1`, `META_API_BASE_URL`→mock, `META_TIMEOUT_MS=10000`; **mock da Meta** (`scripts/loadtest/mock-meta.mjs`) em serviço separado; worker de staging (mesma imagem, `DISPATCH_LOAD_TEST=1`). **Nunca** produção nem a Meta real (`gate.ts:13`, `docs/disparador-bancada-carga.md`).
- Adaptar `load.mjs` (hoje chama o cron em loop): modo `LOAD_MODE=worker` marca os canais de teste como `mode='worker'`, **não** chama o cron para envio e só coleta (cron de manutenção continua a cada 60 s). Medir sempre `pg_stat_statements` antes/depois.

### 9.2 Testes automatizados (no PR de cada fase)
- **Unit:** `reserve`/rate (função pura espelho + PGlite: rajada máx. 1 s, devolução do não usado, `p_rate` nulo), fencing (owner trocado ⇒ vazio), `acquire/renew/release` (expiração, `generation`), `loadChannelWork` (equivale ao `buildChannelWork` atual), sequência de SIGTERM (fake timers: sem ficha nova → drain → release → exit), varredura de imports do bundle (nenhum `next/*`).
- **PGlite** (padrão de `dispatch-batch-claim.sql.test.ts`, `dispatch-rate-by-quality.sql.test.ts`): **não prova concorrência** (1 conexão, `batch-claim.ts:23-24`) — por isso S12.
- Regressão: `dispatch-scheduler.test.ts`, `load-bench*.test.ts`, `startCampaign*.test.ts`, `processQueue.test.ts` verdes após W0.

### 9.3 S2 — degraus de vagas (worker e cron)
Repetir 12→24→48→100→150 vagas **com `DISPARADOR_BATCH_CLAIM=1`**, 1 número, 50k Imediato, primeiro no cron, depois no worker. **Aceite:** escala ~linear até o teto; ≥ 2.000/min no cron sem tick encadeado e **≥ 4.500/min no worker com 100 vagas**; claim p95 < 10 ms; sem estouro de `max_in_flight` (consulta `count(*) WHERE status='enviando'` por número amostrada a cada 1 s ≤ teto).

### 9.4 S3 — 80/s em 1 número (≈ 4.800/min), 30–60 min
Worker dono do número, política verde (80/s), mock com latência 0,85 s/p95 1,0 s e as falhas do `docs/disparador-bancada-carga.md §2`. **Aceite:** **≥ 4.500/min sustentado**; envios/s medidos pelo mock ≤ 1,1 × 80; **lag p99 do worker < 100 ms**; RSS < 60% do limite; CPU do Supabase < 70%; atraso `sent→status aplicado` p95 < 30 s; 0 duplicado (S10); `idas ao banco por envio` ≤ 0,2 (delta de `pg_stat_statements.calls` ÷ envios). Se falhar: registrar o teto e decidir entre 2 números por worker/pooler (W6) × compute maior.

### 9.5 S7 — webhooks 125 → 250 → 500 eventos/s por 15 min (1% duplicados, 2% fora de ordem)
Com e sem o serviço de ingestão. **Aceite:** 200 **p99 < 300 ms**; lag do app p99 < 100 ms; 0 deadlock (`pg_stat_database.deadlocks`); **backlog do inbox < 30 s** (`min(received_at) WHERE processed_at IS NULL`); Inbox p95 < 800 ms; req/s no PostgREST ≈ 10–20 por número. **Decide W5:** só criar o serviço de ingestão se o app falhar neste cenário.

### 9.6 S9 — reinício no meio de S3/S7
Cenários: (a) `docker stop` do worker com SIGTERM (grace 10 s); (b) `kill -9`; (c) deploy "start-first" (dois containers). **Aceite:** **zero evento de status perdido** (contagem do mock × `webhook_status_inbox`/itens); em (a) 0 `enviando` com recibo perdido; em (b) itens em voo viram incertos em ≤ 2 min **sem reenvio** e a quantidade ≤ vagas em voo medidas (registrar); campanha segue em ≤ 45 s (lease expira, cron/outro worker assume); lock do cron recupera em ≤ 2 min (`184`); 0 duplicado.

### 9.7 Novos cenários
| # | Cenário | Aceite |
|---|---|---|
| **S12** | **Concorrência real do claim:** 8–16 conexões chamando `claim_dispatch_batch(_rated)` no mesmo número com 50k itens | conjuntos disjuntos; `enviando` ≤ `max_in_flight` o tempo todo; nenhum item `agendado` perdido; throughput do claim registrado (**pré-requisito para ligar `DISPARADOR_BATCH_CLAIM` e o worker**) |
| **S13** | Lease: kill, SIGSTOP 40 s, relógio, dois workers no mesmo grupo | nunca dois donos vivos; fencing barra o zumbi; assume em ≤ 45 s |
| **S14** | Cron + worker simultâneos no mesmo número (failover/handover) | envios/s ≤ 1,1 × rate (bucket no banco); 0 duplicado |
| **S15** | Reversão: `mode='cron'` com carga a 80/s | cron assume em ≤ 1 tick; sem perda nem duplicado; worker para em ≤ 2 s |
| S4 | 4 números × 20/s, 3 campanhas por número, 1 número com latência 3 s, 2 workers | número lento não derruba os outros; campanhas pequenas terminam em minutos |
| S10 | Duplicidade | `count(*)` por `waha_message_id` e por `(campaign_id, contact_id, template)` = **0** |
| S11 | Qualidade GREEN→YELLOW→RED no mock | limite/s cai em ≤ 1 rodada do worker (≤ 2 s); histórico gravado |

### 9.8 Critérios de aceite para ligar em produção (todos)
1. S12, S13, S14, S15 e S9 aprovados; **S3 ≥ 4.500/min** e **S7 backlog < 30 s**; S10 = 0.
2. Relatório versionado em `docs/` (padrão do PRD 11), com `pg_stat_statements`, lag, RSS, CPU, `docker stats`.
3. Migrations 199–200 aplicadas em produção **e conferidas** (`pg_get_functiondef`), flags desligadas, serviço do worker criado e **ocioso** (grupo vazio) por ≥ 24 h sem erro.
4. Número piloto de **baixo volume** rodou 1 dia útil no worker com métricas ≥ cron (taxa de erro igual, 0 duplicado, 0 `dispatch_worker_lease_lost` não explicado).
5. Alertas da seção 10 ativos e testados (heartbeat, backlog, estouro de rate).
6. Plano de rollback ensaiado em staging (S15) e documentado.

## 10. Observabilidade
- **Eventos** (`system_logs`, `source='disparador'`): `dispatch_worker_tick` (a cada 15 s: `sent`, `sent_per_s`, `in_flight_peak`, `claim_p95_ms`, `confirm_batches`, `event_loop_lag_p99_ms`, `rss_mb`, `rate_effective` por número — mesmo shape de `dispatch-telemetry.ts` para o painel reaproveitar), `dispatch_worker_lease_lost`, `dispatch_worker_lease_acquired`, `dispatch_worker_shutdown` (`drained`, `in_flight_left`), `dispatch_worker_fallback` (cron assumiu), `dispatch_worker_migration_required`.
- **Tabelas:** `dispatch_worker_leases.stats` (heartbeat + métricas p/ `/api/disparador/workers`); `wacrm.dispatch_throughput_per_minute` (164) segue valendo.
- **Alertas (via PRD 15):** sem heartbeat > 60 s com campanha em execução e número em `worker`; `lease_lost` > 3/h; `fallback` ocorrendo; backlog do inbox > 30 s; envios/s > 1,2 × rate efetivo; `incertos` por minuto > N; lag p99 do worker > 100 ms por 3 janelas.
- **Host:** `docker stats` / métricas do EasyPanel por serviço; Supabase: CPU, IO, WAL, conexões, `pg_stat_statements`.

## 11. Riscos, rollback e plano de implantação
**Riscos principais:** (1) perda de ≤ vagas em voo como "incertos" num crash (W12-08) — aceito e medido; (2) divergência entre cron e worker (mitigado por W0 e RF-4); (3) PostgREST como gargalo (W12-10, mitigado por W6); (4) 3 serviços no KVM disputando 4 vCPU (Anexo A); (5) Meta ainda limita por portfólio/qualidade — o worker não muda isso (`DISP-AUDIT §1.4`).

**Degraus (cada um ≥ 1 dia útil, observando `dispatch_worker_tick` e a qualidade/131026):**
- G0 — migrations 199–200 + deploy do código com **tudo desligado**; serviço worker criado **sem grupo** (ocioso). Nada muda para o cliente.
- G1 — **1 número** de baixo volume (conta controlada) em `mode='worker'`; campanha pequena (~500 mensagens).
- G2 — mesmo número limitado a **20/s** (`manual_rate_per_second`) com ~5–10 mil.
- G3 — **80/s** em 1 número (verde) em campanha real, com o piloto acompanhando o Monitor.
- G4 — 2º número (outro worker ou o mesmo, conforme CPU); depois os demais.
- G5 — `DISPARADOR_STATUS_DRAIN_IN_APP=0`; ingestão separada (W5) **só** se S7/produção pedirem.
**Rollback:** por número `mode='cron'` (≤ 1 tick); geral `DISPATCH_WORKER_ENABLED=0` (cron ignora a tabela; o worker para de adquirir lease) e/ou parar o serviço; migrations têm `DROP` documentado e são inertes sem o código.

## 12. Fases e PRs (base `v2`, sem PR empilhado; PR pequeno; dono provável BE/OPS)
| # | PR | Conteúdo | Migration | Dep. | Est. |
|---|---|---|---|---|---|
| **W-1** | **Ops/bancada (sem código de produto)** | staging com compute-alvo; mock; rodar S0–S3/S7/S9–S11 do PRD 11 **com claim em lote ligado**; S12 (concorrência) — dá o "go" para o resto | — | — | M (OPS+BE) |
| W0 | **Refatoração sem mudança de comportamento** | extrair `planTick`/`runSendStage`/`loadChannelWork` de `cron/route.ts` para `src/lib/disparador/`; cron chama as funções | — | W-1 | M |
| W1 | **Lease + ownership + worker mínimo** | migration 199; `scripts/dispatch-worker.ts` (loop 6.5), bundle, `build:worker`, SIGTERM (6.6), transporte realtime (W12-05), audit source; cron pula números com dono vivo (flag); rota `GET /workers` | 199 | W0 | G |
| W2 | **Limite/s no banco** | migration 200; `ChannelClaimer` usa a variante rated; testes PGlite + S14 | 200 | W1 | M |
| W3 | **Aplicador de status no worker** + `DISPARADOR_STATUS_DRAIN_IN_APP` | loop 1 s; S7 sem ingestão | — | W1 | P |
| W4 | **Controle e Monitor** | `PUT/GET /ownership`, histórico, auditoria, 409 de sequencial, alertas | (usa 199) | W1 | M |
| W5 | **Serviço de ingestão** (condicional ao S7) | `scripts/webhook-ingest.ts`, repasse do corpo, bundle, S7 com/sem | — | W3 | M |
| W6 | **Pooler/pg** (condicional ao S3) | `DbRpc` + `pg` (Supavisor, transação), role `dispatch_worker` | 201 | W2 | G |
| W7 | **Ligar em produção** | degraus G0–G5 (seção 11), relatório | — | W1–W4 + S12–S15 | M (OPS) |
Ordem: **W-1 → W0 → W1 → W2 → W3 → W4 → (W5, W6 se a bancada pedir) → W7.** Cada PR com `tsc --noEmit` limpo e vitest `--maxWorkers=2`. Integração com o PRD 11: o heartbeat por item (`inflight_until`, migration 194) melhora o watchdog (W12-08); **não** bloqueia W1.

## 13. Perguntas ao dono
1. **Como o app é construído hoje no EasyPanel** (Dockerfile no repositório do EasyPanel? Nixpacks? Passenger dentro da imagem)? O repositório só tem `.cpanel.yml`/`app.js` (cPanel/Passenger). Preciso disso para o serviço do worker usar **a mesma imagem**.
2. **EasyPanel:** dá para sobrescrever o comando de inicialização por serviço e ajustar o *stop grace period* (hoje 10 s)? Qual o timeout do proxy para `/api/disparador/cron` (precisa ≥ 60 s para o tick encadeado)?
3. **Pico real:** quantos números a 80/s ao mesmo tempo (1, 2, 4)? Define nº de workers e compute (Large × XL).
4. **Autoriza criar um projeto Supabase de staging com o mesmo compute do alvo** (custo mensal) só para a bancada? Sem isso os números não valem.
5. **Failover automático** (cron assume número cujo worker morreu) **ligado por padrão**? Recomendo sim — o claim atômico impede duplicidade e o bucket no banco impede estouro de taxa.
6. **Perda aceitável num crash do worker:** até ≈ as vagas em voo (~80–100 por número) viram "incertas" e **nunca são reenviadas** (política at-most-once). Aceita? (Alternativa: reenviar com risco de duplicar — não recomendo.)
7. **Campanha sequencial** (`batch_size=1`, cadência por `reserve_campaign_tick`): fica no cron na 1ª versão (recomendado) ou entra no worker?
8. **Webhook da Meta:** aceita **trocar a URL** do webhook no painel Meta para um domínio de ingestão (W5) se a bancada exigir? Ou o EasyPanel roteia por caminho no mesmo domínio?
9. **Pooler/`pg` (W6):** autoriza criar o role `dispatch_worker` no banco e guardar a connection string do Supavisor como segredo do serviço, **caso** a bancada mostre PostgREST como gargalo?
10. **Worker para WAHA:** fica fora (recomendado, limite baixo por risco de banimento) — confirma?

---

## Anexo A — Passo a passo no EasyPanel (o que o dono precisa configurar)
> Os nomes das abas podem variar na versão instalada; os valores são os que importam. **Faça primeiro em staging.** Nunca ponha `DISPATCH_LOAD_TEST`, `META_API_BASE_URL` ou `OPENAI_BASE_URL` no ambiente de **produção**.

**A.0 Antes de tudo (banco).** No SQL Editor do Supabase: rode o **pré-check** do cabeçalho e aplique `199` e `200` (uma por vez, conferindo `pg_get_functiondef` de `claim_dispatch_batch`). Faça backup/ponto de restauração. Aplique **antes** do deploy do código.

**A.1 Variáveis do serviço do worker** (aba *Environment* do serviço; mesmos valores do app onde indicado):
```
NODE_ENV=production
NEXT_PUBLIC_SUPABASE_URL=<mesmo do app>
SUPABASE_SERVICE_ROLE_KEY=<mesmo do app>
ENCRYPTION_KEY=<mesma do app>              # decifra tokens/segredos dos canais
META_TIMEOUT_MS=10000
DISPATCH_WORKER_ENABLED=1
DISPATCH_WORKER_GROUP=A                    # um grupo por serviço (A, B, …)
DISPATCH_WORKER_DRAIN_MS=8000
DISPATCH_PROCESS_CONCURRENCY=150
DISPARADOR_PER_NUMBER_CONCURRENCY_META=100
DISPARADOR_BATCH_CLAIM=1                   # só depois do S12 aprovado
DISPARADOR_ASSUMED_P95_S=1
DISPARADOR_MAX_EVENT_LOOP_LAG_MS=150
DISPARADOR_MAX_RSS_MB=600                  # ≈ 60% do limite de 1 GB
NODE_OPTIONS=--max-old-space-size=768
```
No **app**, acrescentar: `DISPATCH_WORKER_ENABLED=1` (para o cron respeitar a tabela) — **só no degrau G1**; até lá fica `0`/ausente. Não coloque `CRON_SECRET` no worker (ele não é chamado por HTTP).

**A.2 Criar o serviço do worker.**
1. EasyPanel → o **mesmo projeto** do app → **+ Service → App**. Nome: `crm-dispatch-worker`.
2. **Source:** o **mesmo repositório GitHub** e branch (`v2`; depois a tag/branch de release). **Build:** o **mesmo método** do app (Dockerfile ou Nixpacks); acrescentar `npm run build:worker` ao build (gera `dist/dispatch-worker.cjs`).
3. **Deploy/Command:** `node dist/dispatch-worker.cjs` (sobrescreve o comando do app).
4. **Domínios e proxy:** **nenhum** (sem porta pública). **Mounts/volumes:** nenhum.
5. **Recursos:** memória **1 GB**, CPU **1,0** (no KVM 4: app ≈ 1,5 vCPU; 1 worker por número ≈ 0,8–1,0 cada; o resto livre — **não** passe de ~3 workers no KVM 4 sem medir `docker stats`). **Réplicas: 1** por grupo (nunca 2 com o mesmo `DISPATCH_WORKER_GROUP`).
6. **Zero-downtime:** deixe **desligado** no começo (o lease já evita dois donos; ligue só depois do S9(c)). **Reinício automático:** ligado.
7. **Grace period de parada:** manter ≥ 10 s (o drain usa 8 s). Se o EasyPanel permitir, suba para 15 s e aumente `DISPATCH_WORKER_DRAIN_MS` para 12000.
8. **Deploy.** Veja *Logs*: deve aparecer `dispatch_worker_boot` e, ocioso, "nenhum número em modo worker".

**A.3 Mover um número para o worker (degrau G1).** Com a flag no app e no worker ligadas: tela **Números → "Executar no worker"** (contrato da seção 8; owner) ou SQL: `INSERT INTO wacrm.dispatch_channel_ownership(session_id, mode, worker_group, reason) VALUES ('<uuid>','worker','A','piloto G1') ON CONFLICT (session_id) DO UPDATE SET mode='worker', worker_group='A', updated_at=now();`. Em ≤ 2 s o worker adquire o lease; no Monitor o número mostra "Worker" e o cron deixa de enviá-lo.

**A.4 Voltar para o cron (rollback).** Número: `mode='cron'` (≤ 1 tick). Tudo: `DISPATCH_WORKER_ENABLED=0` no app (reinicie) e/ou **Stop** do serviço do worker (SIGTERM, drain de 8 s).

**A.5 Serviço de ingestão (só se W5 aprovada).** Repita A.2 com nome `crm-webhook-ingest`, comando `node dist/webhook-ingest.cjs`, variáveis `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `META_APP_SECRET` (se usado), `APP_WEBHOOK_URL=http://<serviço-do-app>:<porta>/api/whatsapp/webhook` (rede interna do EasyPanel); **domínio** só nele **se** a URL do webhook na Meta for trocada (pergunta 8); recursos 512 MB / 0,5 CPU; réplicas 1.

**A.6 Cron externo (já existente) — conferir.** `POST /api/disparador/cron` a cada 60 s (`x-cron-secret`), `POST /api/disparador/prepare/cron` e `POST /api/disparador/health/cron` a cada 5–10 min. Para o tick encadeado: timeout do proxy ≥ 60 s e `DISPARADOR_TICK_CHAIN=1` (`docs/disparador-tick-encadeado.md`).

**A.7 Monitorar.** EasyPanel: *Logs* e *Metrics* (CPU/memória) por serviço; Monitor do CRM (card Workers); Supabase → Reports (CPU, IO, conexões). Alerta manual até o PRD 15: se o heartbeat do worker passar de 60 s com campanha rodando, volte o número para `cron`.

**A.8 Pooler Supavisor (só W6).** Supabase → Project Settings → Database → **Connection pooling** → copiar a *connection string* **Transaction mode (porta 6543)**; guardar como `DISPATCH_WORKER_DATABASE_URL` **só** no serviço do worker (secret); conferir *Pool size* e o limite de clientes do plano; criar o role `dispatch_worker` (migration 201) e usar a senha dele na string.
