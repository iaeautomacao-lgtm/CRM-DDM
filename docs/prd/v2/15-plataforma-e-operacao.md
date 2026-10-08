# 15 — Plataforma e operação (V2 backend)

> Base: branch `v2` (`origin/v2` @ `4fbbbfe`, 08/10/2026), worktree `wt-codex`. Revisão **somente leitura** (nada executado: sem testes, build ou rede). Todas as linhas foram conferidas no código atual; o que só o ambiente real responde está marcado **"A confirmar no live"** (query/comando exato no fim de cada bloco e na seção 13).
> Restrições respeitadas: Meta×WAHA sempre bifurcados (o inbox guarda evento normalizado por provedor, os parsers continuam separados); sem worker em memória no Passenger (tudo recorrente = cron stateless ou serviço separado no EasyPanel); migrations manuais, idempotentes, com pré-check, `CREATE INDEX CONCURRENTLY` sozinho; não mexer na truncagem do `engine.ts` nem em `hasRunLeftNodeSnapshot`; opt-out obrigatório; `limite_por_hora` não muda; **retenção de dados fora do escopo**.
> Relacionado: PRD 14 (segurança e dados) é dono de: rate limit compartilhado (RPC), tipos gerados/`schema.live`, `server-only`, segredos. Este PRD consome essas peças (marcadas "→14").

## 1. Resumo

- **Problema:** a plataforma funciona, mas a camada de operação é frágil. (1) A mensagem do cliente (Meta) só é gravada **depois** do 200 em `after()`: restart/erro entre o 200 e o insert = mensagem perdida para sempre (a Meta não reenvia); só os *status* têm inbox durável (migration 185). (2) Nenhum agendador está versionado e **não existe alerta ativo** (nem "sem cron há N min"). (3) O gate de schema do deploy parou na migration 143 (hoje existem até a 193) e não há registro do que foi aplicado em cada banco. (4) O CI não roda para PRs na `v2`. (5) A API pública v1 não envia template, não respeita janela de 24h e não expõe códigos de erro estáveis.
- **Objetivo:** "blindado e 100%" atrás da tela: nenhuma mensagem recebida se perde; cada cron tem dono, frequência e alarme; deploy/rollback/migrations rastreáveis; API v1 utilizável por integradores de cobrança.
- **Ganho:** zero perda de mensagem (medida), detecção de motor/cron parado em ≤ 3 min com notificação, deploy reproduzível com `schema:check` real, CI cobrindo a `v2`, API v1 com contrato estável.
- **Não-objetivo central:** não reescrever o Inbox/engine; não introduzir worker em memória; não mexer em retenção.

## 2. Estado atual (com arquivo:linha)

### 2.1 Webhook de mensagens (Meta, WhatsApp Cloud) — `src/app/api/whatsapp/webhook/route.ts`
1. `POST` (`:220`) valida corpo ≤ 1 MB (`:224-233`), HMAC por canal (`verifyChannelKey :428-491`, fail-closed `:289-298`), descarta canais não validados (`:322-333`).
2. **Status** (delivered/read/failed) → `ingestStatusEvents` (RPC `ingest_status_events`, mig. 185) **antes** do 200; falha = 500 (`:356-364`).
3. `after()` (`:366-378`) roda `processWebhook` (contato, conversa, mídia, insert, gatilhos) e `drainStatusInbox`. Depois responde 200 (`:380`). **A partir daqui nenhuma mensagem está no banco.**
4. `processMessage` (`:835-1205`): contato (`:1490-1556`) → conversa (`:1558-1623`, sem lock) → `parseMessageContent` com download de mídia **síncrono** (`:885`, `:1313-1478`) → `INSERT messages` (`:945-961`; 23505 = duplicata; outro erro = só `console.error` + `return`, `:969-978`) → UPDATE conversa + RPC unread (`:987-1018`) → `dispatchInboundToFlows` com `await` (`:1064-1085`) → IA/sentimento/acordo com `setTimeout` em memória (`:1103-1147`; `responder.ts:645`) → automações sem await (`:1178-1204`).
5. **WAHA** (`whatsapp/webhook/waha/route.ts:28-888`): tudo síncrono antes de responder (espera 3 s no eco `fromMe` `:286`; fluxos com `await` `:746`); sem `after()` nem inbox. **Social** (`meta/webhook/route.ts:41-67`, `lib/channels/ingest.ts`): 200 e `after()`, sem inbox. **Webchat** (`webchat/[token]/messages/route.ts:155-196`): grava antes de responder (ok), `message_id` aleatório no servidor.
6. Ordem exibida no Inbox: `received_at` (`components/inbox/message-thread.tsx:469`; `messages.received_at DEFAULT NOW()`, mig. 043) = ordem de **processamento**, não de envio.
7. Carga estimada (a medir): 15–30 chamadas HTTP/PostgREST por mensagem de texto (ver WH-15/16) → 1.200–2.400 chamadas/s a 80 msgs/s.

### 2.2 API pública v1 — `src/app/api/v1/**`
Rotas: `me`, `whatsapp/send`, `disparador/campaigns` (POST), `disparador/campaigns/{id}` (GET), `reports/*`, `openapi.json` (pública). Auth por chave (`Bearer wacrm_live_…`, só SHA-256 no banco, `lib/auth/api-context.ts`), escopos em `api_keys.scopes`, envelope `{data}` / `{error:{code,message}}` (`respond.ts:30-40`). Idempotência **no banco** (`send_operations`, mig. 124; campanhas, mig. 173). Rate limit 120/min **por chave, em `Map` por processo** (`lib/rate-limit.ts:34,86-95`). Único webhook de saída: `campaign.completed` (`campaign_callback_outbox`, mig. 122; SSRF bem coberto: `safeFetch` com IP fixado, redirects revalidados).

### 2.3 Observabilidade
`system_logs` (writer único `src/lib/logger.ts:48-80`, **engole qualquer erro**; níveis `debug|info|warn|error|critical`), `audit_logs` (`lib/audit/log-event.ts`), `cron_tick` (1 linha/tick em `disparador/cron/route.ts:770`), telemetria de front (`/api/telemetry`), tela `/ddm-logs`, Monitor v2 (`engine.stale`, `ENGINE_STALE_SECONDS=180`, `monitor-snapshot.ts:203,412-433`, só com a tela aberta e só com campanha rodando). **Não há** `/api/health`, request id, alerta push (Slack/e-mail/WhatsApp), nem detecção de parada para flows/automations/prepare/health. 749 `console.*` em `src/`.

### 2.4 Crons
Nenhum agendador versionado (sem crontab, sem config de EasyPanel). `docs/operations.md:30-33` lista 3 crons e omite `CRON_SECRET`, `prepare`, `health`, `refresh-tokens`, `stress/run`. Lista completa na seção 6.4.

### 2.5 Testes e CI
`.github/workflows/ci.yml:3-7`: dispara só em PR com base `main` e push em `main` (lint, `tsc`, `vitest run`, `next build` com variáveis dummy; sem `schema:check`, sem `format:check`). 255 arquivos de teste (~2.400 `it/test`), ~27 `*.sql.test.ts` em PGlite (carregam migrations reais), **~100 das 146 rotas sem teste** (inclusive todos os crons exceto `disparador/cron` e `prepare/cron`). `vitest.config.ts:1-21` sem `testTimeout`/`hookTimeout`/`maxWorkers`; só 3 arquivos PGlite declaram timeout de 60 s. Bancada de carga #132 (`scripts/loadtest/*`, `src/lib/loadtest/gate.ts`): manual, fora do CI.

### 2.6 Ambientes, deploy, migrations
Deploy de produção só em texto (CLAUDE.md: `git pull && nvm use 20.19.0 && npm run build && touch tmp/restart.txt`). O único deploy versionado (`.cpanel.yml:2-10`) mira `omnichannel-v2-desenvolvimento` e usa `npm install`. `scripts/check-schema-readiness.mjs:20` exige `EXPECTED_SCHEMA_VERSION = 143` (`app_schema_version()` = 143 na mig. 143); migrations existentes: 198 arquivos, até 193. **Não há registro de migrations aplicadas por banco.** `src/middleware.ts` usa a convenção deprecada no Next 16.2.6 (`proxy`; `next.config.ts:98` já usa `proxyClientMaxBodySize`).

## 3. Problemas e riscos

IDs mantêm a numeração da revisão (WH = webhook/Inbox, API = API v1, P = plataforma). "Onde" é arquivo:linha na `v2`.

### 3.1 Webhook de mensagens e Inbox

| ID | Sev. | Onde | Problema | Cenário de falha | Correção |
|---|---|---|---|---|---|
| WH-01 | **CRÍTICA** | `whatsapp/webhook/route.ts:366-380`, `:493-644` | Mensagem da Meta não é gravada antes do 200 (só status têm inbox). | Restart do Passenger/deploy (`touch tmp/restart.txt`), OOM ou exceção entre o 200 e o insert: a Meta recebeu 200 e não reenvia; mensagem do cliente some. Contato/conversa podem ficar criados e vazios. | Inbox durável de mensagens (seção 6.1). |
| WH-02 | **CRÍTICA** | `route.ts:963-978` | Insert que falha com erro ≠ 23505 → só `console.error` + `return`. | Timeout/5xx do PostgREST ou CHECK de `content_type` = mensagem perdida, sem retry nem dead-letter nem `writeLog`. | Com o inbox: `attempts+1` com backoff e `dead` após N; alerta. |
| WH-03 | ALTA | `route.ts:624-641`, `:855`, `:622` | Loop sem try/catch por mensagem; `contact.profile.name` sem guarda; `decrypt(access_token)` por change. | Um throw (perfil ausente, token que não decifra) aborta as demais mensagens do mesmo POST (outros clientes). | try/catch por mensagem/change; no inbox cada mensagem é uma linha. |
| WH-04 | ALTA | `route.ts:625-626` | `value.contacts[i] \|\| contacts[0]`: a Meta não alinha `contacts[]` com `messages[]` por índice. | Nome do cliente A gravado no contato B (`findOrCreateContact` faz UPDATE de `name`, `:1510-1515`). Cobrança com nome trocado. | `contacts.find(c => c.wa_id === message.from)`; só atualiza nome se houver correspondência. |
| WH-05 | ALTA | `route.ts:885-886`, `:1359-1377`, `:945-962`; `message-thread.tsx:469` | Insert só depois do download da mídia; Inbox ordena por `received_at`. | Foto e logo depois "esse é o comprovante": o texto grava em 100 ms, a foto em 2 s → texto aparece antes da foto; fluxo/IA recebem o texto primeiro; quebra o debounce da IA (`responder.ts:644-675`). | Gravar a mensagem primeiro (mídia depois, em estágio próprio); ordenar por `(event_ts do provedor, id)`; serializar por conversa. |
| WH-06 | ALTA | `route.ts:1355-1477` | Sem `case 'button'` (resposta de quick-reply de **template de campanha**), `order`, `contacts`, `system`; `value.errors` ignorado. | Resposta "SIM/Quero negociar" a uma campanha vira `[Unsupported message type: button]`: fluxos, palavras-chave e IA não a veem. (Confirmado por comentário em `ai/sentiment-trigger.ts:36`.) | Tratar `button` (`button.text` → texto, `payload` → `interactiveReplyId`), `contacts`, `order`; registrar `value.errors`. |
| WH-07 | ALTA | `route.ts:1569-1623`; `waha/route.ts:422-468`; `ingest.ts:213-245`; `v1/whatsapp/send/route.ts:507-603` | Sem UNIQUE de "uma conversa aberta por contato+canal"; procura-e-cria sem lock. | Duas mensagens do mesmo contato em POSTs paralelos criam duas conversas: unread/SLA/fluxo/atribuição divididos; Inbox mostra a pessoa duas vezes. | Índice único parcial + `INSERT … ON CONFLICT` (ou RPC `get_or_open_conversation`); medir duplicatas antes (seção 7). |
| WH-08 | ALTA | `waha/route.ts:93-878`, `:286`, `:746-759`, `:815-856` | WAHA processa tudo antes de responder, inclusive fluxo+IA e espera de 3 s no eco `fromMe`. | WAHA expira e reenvia; restart no meio de fluxo/IA: a reentrega vê "já sincronizada" (`:295`) e **os gatilhos (fluxo, IA, automação) nunca disparam**; rajada de ecos acumula conexões abertas. | Mesmo inbox com `provider='waha'`; eco vira linha com `next_attempt_at = now()+3 s`. |
| WH-09 | MÉDIA | `waha/route.ts:422-433` vs `route.ts:1569-1590` | Regra de conversa diverge: Meta abre nova se a última está `closed`; WAHA reutiliza qualquer (`convsList[0]` arbitrário). | Mesmo cliente com comportamento diferente por canal; `convsList[0]` pode ser uma conversa antiga. | **Decisão da operação (4.1): quando abrir/reabrir/encerrar conversa é regra de negócio — sem requisito nem PR.** Risco técnico a registrar: `convsList[0]` sem ordenação é não determinístico. |
| WH-10 | MÉDIA | `route.ts:938-943`, `:945-962`; `waha/route.ts:727-732`; `ingest.ts:70-74` | `isFirstInboundMessage` por `count` sem lock. | Dois gatilhos `first_inbound_message`/dois fluxos "primeira mensagem" em rajada. | Derivar de `INSERT … RETURNING`/`first_inbound_at` atômico. |
| WH-11 | MÉDIA | `route.ts:1104-1142`; `waha/route.ts:828-865`; `ai/sentiment-trigger.ts:50-67`; `ai/acordo-trigger.ts:21-35`; `responder.ts:645` | IA (4 s), sentimento (8 s), sugestão de acordo (15 s) via `setTimeout` em memória. **Viola a regra do Passenger.** | Restart entre 4 e 15 s: a IA nem responde, sem retry nem rastro (há `claim_ai_reply` contra duplicidade, nada contra perda). | Estágio `side_effects` do inbox; debounce por coluna (`conversations.ai_due_at`) drenada pelo cron. Sentimento/acordo: só a durabilidade do timer entra aqui (mesmos intervalos e comportamento); regra de *quando/como* é Decisão da operação (4.1). |
| WH-12 | MÉDIA | `route.ts:1182-1204`; `waha/route.ts:773-791`; `ingest.ts:144-153` | Automações sem idempotência e sem retry. | Falha some; um futuro retry do inbox duplicaria a execução. | Marcador de estágio at-most-once ou chave `(automation_id, message_id)`. |
| WH-13 | MÉDIA | `route.ts:1233-1311`, `:1380-1434`; `meta-api.ts:1213,1259` | Só imagem/áudio vão para `chat-media`; vídeo/documento/sticker ficam no proxy da Meta (retenção ~30 dias); `downloadMedia` lê tudo em memória antes de checar `maxBytes`; path `meta/${mediaId}.ext` sem prefixo de conta, `upsert:true`. | Comprovante em PDF/vídeo de cobrança some após a retenção; vários downloads grandes simultâneos estouram memória. | Estágio `media` com retry; copiar todos os tipos para `chat-media/account-<id>/`; abortar por `Content-Length` e stream com teto; `messages.media_state`. |
| WH-14 | MÉDIA | `route.ts:580-583` | `select('*')` em `whatsapp_config` (traz segredos) por change, além do cache de `verifyChannelKey`. | +1 query pesada por POST (80/s = 80 SELECTs/s extras). | Reaproveitar o canal verificado; cache 60 s. |
| WH-15 | MÉDIA | `route.ts:938-1031`; triggers `178`, `133`, `088` | Cada inbound toca a mesma linha de `conversations` 3× (trigger SLA, `convUpdates`, `increment_unread_count`); `last_message_at` sem "só avança". | ~15–30 chamadas HTTP por mensagem; mensagem processada tarde **regride** `last_message_*`. | RPC única `persist_inbound_message` (1 round-trip, `GREATEST(last_message_at, …)`). |
| WH-16 | MÉDIA | `route.ts:224-241`, `:380` | Sem backpressure: sempre 200 e N `after()` concorrentes. | Rajada de 80 POSTs/s = 80 `processWebhook` simultâneos; pool do PostgREST satura e **o Disparador (mesmo banco) desacelera**. | Drenagem em lote com concorrência fixa (8–16 conversas) e métrica de profundidade. |
| WH-17 | MÉDIA | `route.ts:624-641`, `:1056-1086` | Mensagens do mesmo POST em sequência; `await dispatchInboundToFlows` pode levar dezenas de segundos. | Head-of-line: a mensagem 2 (outro cliente) espera fluxo/IA da 1. | `persist` rápido para todas; `side_effects` em paralelo por conversa. |
| WH-18 | MÉDIA | `meta/webhook/route.ts:49-67`; `ingest.ts:21-153` | Social: 200 antes de tudo, sem inbox; HMAC com segredo **global**; sem teto de corpo; rede (`fetchSocialProfile`, anexo) no caminho. | Mesma perda do WH-01 para DMs; app Meta próprio que conheça o segredo global injeta eventos em qualquer canal social. | Inbox `provider='social'`; teto de corpo; validar `entry.id` × `channels.external_id` antes de gravar. |
| WH-19 | MÉDIA | `webchat/[token]/messages/route.ts:155-196` | `message_id` = `webchat-in-${randomUUID()}` no servidor; fluxo/sentimento em `after()` sem retry. | Reenvio do widget (rede/duplo clique) duplica; restart antes do `after()` = fluxo não roda. | `client_message_id` do widget (UNIQUE parcial); estágio `side_effects` do inbox só para os gatilhos. |
| WH-20 | MÉDIA | `app/api/calls/[...path]/route.ts` | `/api/calls/*` é só proxy autenticado para o serviço VoIP em Go; evento `calls` da Meta não é tratado no webhook Next. | Se a Meta apontar `calls` para o Next, é descartado sem log. | **A confirmar no live (13.2)**; senão documentar que a durabilidade é do serviço Go (`wacalls.db`). |
| WH-21 | BAIXA | `route.ts:969-975` | Dedupe por 23505 só depois de baixar mídia + ~6 queries. | Reentrega da Meta reexecuta tudo à toa. | Dedupe pelo UNIQUE do inbox, antes de qualquer trabalho. |
| WH-22 | BAIXA | `waha/route.ts:146-204`, `:93-141` | Reação WAHA: DELETE+INSERT sem transação/UNIQUE; `message.revoked` assinado (`waha-api.ts:159`) mas não tratado. | Reação duplicada; mensagem apagada pelo cliente continua visível. | Upsert com a mesma chave da Meta; tratar `revoked`. |
| WH-23 | BAIXA | `route.ts:296-300` (mig. 088) | UNIQUE de `messages.message_id` é global e parcial. | Praticamente nulo (colisão de IDs WAHA entre sessões). | Considerar `(account_id, message_id)` na migration do inbox. |

### 3.2 API pública v1

| ID | Sev. | Onde | Problema | Cenário de falha | Correção |
|---|---|---|---|---|---|
| API-01 | ALTA | `v1/whatsapp/send/route.ts:393-404`, `:211-218` | Envio avulso sem template e sem checagem da janela de 24h. | Integrador de cobrança manda aviso a quem não escreveu nas últimas 24h: 502 `internal` com o texto cru da Meta (131047); sem como enviar template. | `template:{name,language,variables}` no canal Meta; calcular janela (mesma regra de `findOrCreateConversation`); 422 `outside_window` com `template_required`. |
| API-02 | ALTA | `send/route.ts:211-218` | Canal = "config habilitada mais antiga"; sem parâmetro `channel` (a rota de campanhas tem, `campaigns/route.ts:238`). | Conta com Meta+WAHA: sai sempre pela linha mais antiga (pode ser a errada); conversa criada presa nela. | Parâmetro `channel` (UUID); 400 explícito se houver >1 canal e nenhum informado. |
| API-03 | ALTA | `lib/disparador/send-ledger.ts:73-89`; `send/route.ts:300,429-432` | Erro definitivo do provedor lança 502 **depois** de `providerCalled`: a reserva fica `reserved` para sempre e o erro não é gravado. (O ledger é no banco, não em memória; o "preso" é estado `reserved` eterno.) | Integrador corrige o destinatário e reenvia com a MESMA chave: 409 `provider_outcome_unknown` para sempre. | Distinguir erro definitivo (4xx com código Meta conhecido) de incerto (timeout/rede): definitivo persiste a resposta de erro (`completed`); incerto fica `reserved` com TTL + reconciliação (já existe `reconcile-unknown-provider-outcomes.ts` para o Disparador). |
| API-04 | ALTA | `lib/rate-limit.ts:34,86-95`; `lib/auth/api-context.ts:107` | Rate limit em `Map` por processo (120/min/chave); sem limite por conta nem global. | N workers = N×120; restart zera; 2/s é baixo para integração transacional. | RPC compartilhada (→14 §6.5), limites por escopo (envio×leitura) e por conta; documentar o limite real. |
| API-05 | ALTA | `processQueue.ts:1253-1260`; `callback-outbox.ts:33-37` | Webhook de saída sem HMAC, sem segredo, sem timestamp; retry infinito (backoff até 1 h, sem teto/dead-letter); só existe `campaign.completed`. | Receptor não autentica a origem (forja `campaign.completed`); URL morta tenta para sempre; integrador faz polling de respostas/entregas. | `X-CRM-Signature: t=<ts>,v1=HMAC_SHA256(secret, ts.body)` com segredo por endpoint (cifrado via `resolveSecretForWrite`), teto (12) + `dead`, tabela de endpoints com eventos (`message.received`, `message.status`, `campaign.completed`). |
| API-06 | MÉDIA | `api/v1/**` (catálogo só em `disparador/*`); `respond.ts:30-40` | `meta-error-catalog.ts` não é exposto; `ApiErrorCode` sem `outside_window`, `template_not_approved`, `channel_paused`, `recipient_invalid`. | Integrador não decide entre retry, corrigir cadastro ou desistir. | Mapear Meta→código estável (`provider_error` + `provider_code` + `retryable`) pelo catálogo; listar no OpenAPI. |
| API-07 | MÉDIA | `lib/api-keys/scopes.ts:17-27` | Escopos `messages:read`, `contacts:*`, `conversations:read` existem sem nenhuma rota. | Falsa sensação de cobertura; não há como consultar status de mensagem avulsa nem itens/erros de campanha. | Implementar `GET /messages/{id}`, `GET /disparador/campaigns/{id}/items` (keyset, com `error_code`), `GET/PUT /contacts` — ou esconder os escopos até existirem. |
| API-08 | MÉDIA | `api-context.ts:96-132`; `api-keys/store.ts:80-95` | Cada chamada: SELECT por hash, UPDATE de `last_used_at`, INSERT em `system_logs`. | 3 operações de banco por chamada; UPDATE serializa na mesma linha. | Cache da chave 30–60 s; `last_used_at` ≤ 1×/min; log de 2xx amostrado. |
| API-09 | MÉDIA | `v1/disparador/campaigns/route.ts:318-327`; `processQueue.ts:1203-1211` | SSRF do `callback_url` bem coberto; lacuna é autenticidade (API-05). | Sem risco de SSRF identificado. | Nenhuma ação de SSRF. |
| API-10 | MÉDIA | `campaigns/route.ts:142,184-187,744-748` | Se o processo morre depois de ativar a campanha e antes de gravar `idempotency_response`, o replay recebe 409 "em andamento" para sempre. | Integrador em retry preso sem saber o `campaign_id`. | No replay com `idempotency_response` nulo e campanha `em_execucao`/`agendada`, reconstruir a resposta e devolver 200. |
| API-11 | BAIXA | `lib/api/v1/openapi.ts:142` | OpenAPI 3.1 existe (com teste), mas sem versionamento/depreciação/exemplos de erro por código e sem `X-Request-Id`. | Suporte sem id de correlação. | `X-Request-Id`, `Sunset`, changelog. |
| API-12 | BAIXA | `respond.ts:213-223` | 500 genérico sem `request_id`. | Suporte não correlaciona. | `request_id` no envelope de erro. |

### 3.3 Plataforma: observabilidade, CI, deploy, migrations

| ID | Sev. | Onde | Problema | Cenário de falha | Correção |
|---|---|---|---|---|---|
| P-01 | **CRÍTICA** | `disparador/cron/route.ts:297-299`; `docs/operations.md:30-33`; `tests/stress/README.md:33-55` | Nenhum agendador versionado; doc lista 3 crons e omite `CRON_SECRET`, `prepare`, `health`, `refresh-tokens`, `stress/run`. | Servidor refeito/EasyPanel recriado/crontab perdido: o motor para sem aviso; ninguém sabe URL, frequência e header. | `docs/crons.md` + `ops/crontab.example` + `scripts/ops/install-crontab.sh`; dono nomeado. |
| P-02 | **CRÍTICA** | `monitor-snapshot.ts:203,412-433` | "Sem cron há N min" só existe como alerta **de tela** (só com a página aberta, só com campanha rodando, só o cron do disparador). Nenhum push. Nada detecta parada de flows/automations/prepare/health. | Cron para às 22h com campanha agendada: ninguém olha o Monitor; atraso a noite toda. | Watchdog externo + `cron_status` + `/api/health` + notificador (seção 6.3). |
| P-03 | ALTA | `flows/cron/route.ts:26-33`; `tests/stress/README.md:51-55` | O README sugere que `/api/flows/cron` pode rodar só 1×/dia via `stress/run` (02:00); o código diz que o cron "não é opcional" (índice `idx_one_active_run_per_contact`) e recomenda 5 min; também roda o watchdog de IA (`sweepStalledAiConversations`). | Se só há a chamada diária: runs abandonados bloqueiam o contato por até 24 h; IA travada só se recupera 1×/dia. | **A confirmar no live (13.1)**; agendar a cada 5 min. |
| P-04 | ALTA | `scripts/check-schema-readiness.mjs:20`; mig. 143:41; `.cpanel.yml:9-10` | `EXPECTED_SCHEMA_VERSION=143`; migrations 144–193 não são verificadas; 12 sondas de colunas antigas; **não existe registro de migrations aplicadas**. | Código da 188/192 sobe em banco sem a migration: `schema:check` passa e a falha aparece em runtime (mesma classe do incidente #143). | `wacrm.schema_migrations` + `supabase/required-migrations.json` (seção 6.5). |
| P-05 | ALTA | `.github/workflows/ci.yml:3-7` | CI só roda para `main`. PRs com base `v2` não rodam lint, tipos, testes nem build. | Merge na `v2` com erro de tipo/teste quebrado; só aparece ao promover `v2`→`main`. | Incluir `v2` (e `release/*`); proteger `v2` com o check obrigatório. |
| P-06 | ALTA | `.cpanel.yml:2-10` | Único deploy versionado aponta para `omnichannel-v2-desenvolvimento` e usa `npm install`; o de produção está em texto e não roda `schema:check`. | Seguir o arquivo errado reinicia o ambiente errado; `npm install` altera a árvore entre staging e prod. | `scripts/deploy.sh <ambiente>` único (`pull`, `npm ci`, `schema:check`, `build`, `touch`). |
| P-07 | ALTA | `src/middleware.ts:86,204-209` | Convenção `middleware` deprecada (renomeada para `proxy` no Next 16, `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:11`); `next.config.ts:98` já usa `proxyClientMaxBodySize`. | Hoje só aviso no build; a remoção da convenção derruba auth de borda e o limite de corpo de 50 MB. | Codemod `middleware-to-proxy`; validar limite de corpo e `security-routes.test.ts`. (Interação com AP-05/06 do PRD 14.) |
| P-08 | ALTA | `vitest.config.ts:1-21` | Sem `testTimeout`/`hookTimeout`/`maxWorkers`; só 3 de ~27 arquivos PGlite têm timeout 60 s. | `beforeAll` carrega dezenas de migrations no PGlite (WASM); sob carga estoura (vimos `webhook-status-batch` falhar no padrão de 5 s e passar com 60 s). Teste intermitente no CI. | `testTimeout: 30_000`, `hookTimeout: 120_000`, `maxWorkers` 2–4 e projeto separado para `*.sql.test.ts`. |
| P-09 | ALTA | `whatsapp/meta-api.ts`; `eslint.config.mjs`; incidente #144 (`a62aeab`) | `validate.ts` (navegador) importou `meta-api.ts` (→ `undici`, gate da bancada) e o editor de fluxos parou de abrir; o `next build` do CI passou. Só 3 arquivos usam `server-only`; sem `no-restricted-imports`. | Qualquer import novo de módulo de servidor em componente cliente repete o incidente. | →14 §6.4: `server-only` + regra ESLint + teste de grafo. Este PRD só liga o job no CI. |
| P-10 | ALTA | `src/app/api/**/route.ts` | ~100 rotas sem teste, incluindo crons, `meta/webhook`, `telemetry`, `feedback`, `redeem`, `transfer-ownership`, `webchat/*`, `mcp`, `whatsapp/config`. | Regressão de autenticação de cron (aceitar sem segredo) ou de `redeem` passa no CI. | Teste parametrizado "todo cron: sem segredo → 401/503; segredo errado → 401" (padrão `role-gate.test.ts`); contratos para `webhook`, `redeem`, `transfer-ownership`. |
| P-11 | MÉDIA | `082_system_logs.sql:27-29`; `monitor-snapshot.ts:570`; `desempenho-extra.ts:41` | Retenção do `system_logs` só como comentário (**fora do escopo propor política**); cada tick grava 1 `cron_tick` grande (milhares/dia com tick encadeado, `docs/disparador-tick-encadeado.md:20`); sem índice para `event='cron_tick'`. | Crescimento sem limite; consultas do Monitor degradam. | Índice parcial `ON system_logs (created_at DESC) WHERE event='cron_tick'` (CONCURRENTLY, arquivo próprio). Tamanho: 13.4. |
| P-12 | MÉDIA | `src/lib/logger.ts:48-80` | `writeLog` engole erros; o CHECK de `source`/`level` (082) rejeita valor novo em silêncio; sem contador. | `source` novo no TS sem migration = telemetria inteira perdida sem sinal. | Teste que compara `LogSource` do TS com o CHECK; `console.error` + contador em `/api/health`. |
| P-13 | MÉDIA | `src/` (749 `console.*`) | Sem request id; 500 de rota só em `console.error`; sem agregação. | Incidente de 500: vasculhar log do Passenger sem filtrar por requisição. | `x-request-id` no proxy, propagado a `writeLog`/`console`; `withApiLogging` grava `api_error`. |
| P-14 | MÉDIA | `api/telemetry/route.ts`; `api/feedback/route.ts` | Escrita (service role) sem limite; `user_bug_report` não notifica ninguém. | Loop de erro de front inunda `system_logs`; relato de bug invisível. | Rate limit compartilhado (→14) e alerta de suporte. |
| P-15 | MÉDIA | `.env.local.example` | Falta `CRON_SECRET` (só `AUTOMATION_CRON_SECRET`), `DISPARADOR_*`, `AI_*`, `WAHA_WEBHOOK_*`; `DDM_LOGS_USER/PASSWORD` listadas mas não lidas. | Novo ambiente sobe sem `CRON_SECRET`: disparador 503 sem explicação. | Reescrever o exemplo por ambiente (tabela 6.6). |
| P-16 | MÉDIA | `src/middleware.ts:10`; `tests/stress/README.md` | Fallback do ref do Supabase e doc de stress apontam para `mkrkkvbseobdqsalrorl` (projeto antigo); produção é `cyftbffhgjmsfogxawrl`. | Sem `NEXT_PUBLIC_SUPABASE_URL` no runtime o cookie esperado é de outro projeto: todo usuário cai em `/login` em loop; stress mira o projeto errado. | Remover o fallback (falhar alto); atualizar README. |
| P-17 | MÉDIA | `conversations/retry-assignment/route.ts:6-15`; `automations/cron/route.ts:14-17` | `retry-assignment` usa `timingSafeEqual` manual (vaza tamanho) sem ator de auditoria; `automations/cron` usa `status='running'` como "lock" sem lease. | Deploy no meio do drain: execuções ficam `running` para sempre (**confirmar 13.8**). | `matchesOperationalSecret`; reclamar `running` por `updated_at` antigo ou `try_acquire_cron_lock`. |
| P-18 | MÉDIA | migrations `113`, `132`, `133`, `143` | Números duplicados (e lacunas 149, 151, 156); sufixos `187b/189b/191b` por causa do CONCURRENTLY. | Ordem de aplicação ambígua; difícil dizer o que está no banco. | `schema_migrations` + CI que falha em número duplicado acima de 193. |
| P-19 | BAIXA | `disparador/cron/route.ts:362-366` | Heartbeat do lock por `setInterval` dentro da requisição (compatível com Passenger) morre no restart; lock expira em ~90 s (mig. 184). | Deploy no meio do tick: até ~90 s sem envio (documentado em `:354`). | Só runbook: "evite deploy no pico; espere 90 s". |
| P-20 | BAIXA | `.github/workflows/ci.yml:40-49` | Sem `format:check`/`schema:check`; Node 20 sem fixar a minor. | Diferença de Node entre CI e produção (20.19.0) passa despercebida. | `node-version-file: .nvmrc` com `20.19.0`. |
| P-21 | BAIXA | `next.config.ts:13-24,92` | `deploymentId` = `NEXT_DEPLOYMENT_ID` ou SHA via `git rev-parse` no build; sem `.git` o id fica vazio e a proteção contra skew some em silêncio. | Aba antiga chama API nova (erro React #130). | Exigir `NEXT_DEPLOYMENT_ID` no `deploy.sh`; falhar o build se vazio em produção. |
| P-22 | BAIXA | `monitor-snapshot.ts:492,565` | `cron_tick` não tem `account_id` (motor único); telas por conta derivam pelos canais. | Sem vazamento; telemetria por conta é derivada. | Sem ação; só registrar. |

## 4. Objetivos e não-objetivos

**Objetivos**
1. Nenhuma mensagem recebida (Meta, WAHA, social) se perde por restart/erro: gravação durável antes do 200 e processamento idempotente em estágios.
2. Ordem correta por conversa e mídia fora do caminho crítico.
3. Todo cron versionado, com dono, frequência, segredo e alarme de parada ("sem cron há N min") **notificado**, não só mostrado em tela.
4. Deploy, rollback e migrations rastreáveis: `schema:check` de verdade, registro por banco, CI cobrindo `v2`.
5. API v1 com contrato estável para integradores de cobrança: template + janela 24h, escolha de canal, erros estáveis, idempotência sem chave presa, webhooks de saída assinados.
6. Testes que travam as classes de incidente conhecidas (#143 coluna inexistente, #144 import server→client, timeouts PGlite).

**Não-objetivos:** reescrever o Inbox ou o engine; worker em memória; mexer na truncagem do `engine.ts`/`hasRunLeftNodeSnapshot`; unificar Meta×WAHA (a bifurcação continua no envio e nos parsers); alterar `limite_por_hora`; política de retenção; frontend (só contrato, seção 8).

## 4.1 Decisão da operação (REGRA DO DONO, 08/10) — fora do escopo técnico

Prompt, textos da IA (inclui fallback "Ben"), personas, quando encerrar conversa/handoff, tratamento de ofensa, quando/como propor ou efetivar acordo e régua/mensagens de cobrança **não são escopo deste PRD**: sem requisito de mudança de comportamento e sem PR.

| Item (negócio) | Risco técnico observado (e só isso) | Onde |
|---|---|---|
| Quando abrir/reabrir/encerrar conversa (Meta abre nova após `closed`; WAHA reutiliza) | `convsList[0]` sem `.order` é não determinístico se houver duplicata (o índice único do WH-07 não altera a regra; só impede duplicata simultânea). | WH-09 |
| Debounce/espera da IA (4 s), sentimento (8 s), sugestão de acordo (15 s) | Os timers vivem em memória e se perdem no restart. **O requisito é só de durabilidade do timer (mesmos intervalos, mesmo comportamento)**; *se* e *quando* a IA responde, sugere acordo ou muda sentimento é decisão da operação. | WH-11, `responder.ts:645`, `sentiment-trigger.ts`, `acordo-trigger.ts` |
| Resposta de botão de template de campanha (`SIM`, `Quero negociar`) | Hoje chega como `[Unsupported message type: button]` (bug de parser). O requisito é só **entregar o texto/payload ao motor**; o que o fluxo/IA faz com a resposta é da operação. | WH-06 |

---

## 5. Requisitos (com critério de aceite)

### 5.1 Funcionais

| ID | Requisito | Aceite (testável) |
|---|---|---|
| RF-01 | O webhook grava o lote de mensagens no inbox **antes** do 200; falha de gravação = 500 (a Meta reenvia). | Teste de rota: `ingest_message_events` falha → status 500; sucesso → 200 e linha em `webhook_message_inbox`. Teste PGlite: reenvio do mesmo `wamid` não duplica (`ON CONFLICT DO NOTHING`). |
| RF-02 | Processamento em estágios idempotentes: `persist` → `media` → `side_effects`; reexecutar qualquer estágio não duplica mensagem, fluxo, IA nem automação. | PGlite: rodar `persist_inbound_message` 2× → 1 linha em `messages`; teste do drenador com falha injetada em cada estágio → retoma sem duplicar. |
| RF-03 | Ordem por conversa pelo horário do provedor (`event_ts`, `id`): foto→texto aparece na ordem de envio mesmo com mídia lenta. | Teste: eventos `foto(event_ts=t1, mídia lenta)` e `texto(t2)` → `messages` na ordem t1,t2; `last_message_at` nunca regride. |
| RF-04 | Esgotadas as tentativas, a linha vai para `dead` (dead-letter) com `last_error`, gera alerta e pode ser reprocessada manualmente. | Teste: 8 falhas → `state='dead'`; `message_inbox_stats().dead = 1`; função de replay recoloca em `pending`. |
| RF-05 | Respostas de botão de template (`type:button`) entram como texto/`interactiveReplyId`; contato é resolvido por `wa_id`. | Testes de `parseMessageContent` e de resolução de contato com `contacts[]` fora de ordem. |
| RF-06 | Uma conversa aberta por contato+canal (índice único parcial). | PGlite: duas inserções concorrentes → 1 conversa; migration aborta com pré-check se houver duplicatas. |
| RF-07 | WAHA e social usam o mesmo inbox (`provider`); eco `fromMe` entra com atraso de 3 s por `next_attempt_at`, sem `setTimeout`. | Teste de rota WAHA: responde em < 500 ms sem aguardar fluxo; eco dedupe com `persistOutboundMessage`. |
| RF-08 | Debounce de IA/sentimento persistido (`conversations.ai_due_at`) e drenado por cron; nada recorrente em memória. | `grep setTimeout` nos gatilhos de IA retorna 0; teste: restart simulado entre 4 e 15 s → IA responde no próximo cron. |
| RF-09 | `/api/health` público e barato; `cron_status` por job; watchdog externo notifica por canal (Slack e/ou WhatsApp) com deduplicação. | Teste: `cron_status.last_ok_at` antigo → alerta aberto 1×, reenvio a cada 30 min, resolve ao voltar. |
| RF-10 | Todo cron versionado em `ops/crontab.example` + `docs/crons.md`; teste "todo cron: sem segredo→401/503". | Teste parametrizado cobre as 10 rotas da tabela 6.4. |
| RF-11 | `wacrm.schema_migrations` + `required-migrations.json`; `schema:check` falha se faltar migration exigida pelo commit; CI falha em número duplicado novo. | Rodar `schema:check` contra banco sem a 192 → exit 1 listando a faltante. |
| RF-12 | API v1: template e janela 24h no `send`, parâmetro `channel`, erros estáveis (`provider_error`+`provider_code`+`retryable`), chave de idempotência não fica presa após erro definitivo, GETs de mensagem e itens de campanha, endpoints de webhook assinados. | Contrato OpenAPI atualizado e teste `openapi.test.ts` por rota; teste: erro definitivo → reenvio com a mesma chave devolve o mesmo erro (não 409). |
| RF-13 | CI roda para `v2` e `release/*`, inclui `schema-drift` (→14), `format:check` opcional e Node 20.19.0. | PR com base `v2` mostra o check; PR com número de migration duplicado falha. |

### 5.2 Não funcionais

| ID | Requisito | Aceite |
|---|---|---|
| RNF-01 | Latência do POST do webhook Meta ≤ 300 ms p95 (1 chamada ao banco + HMAC) a 80 msgs/s. | Bancada: cenário "80 msgs/s de respostas" (estender `scripts/loadtest/*`); p95 medido. |
| RNF-02 | Latência webhook→mensagem visível no Inbox ≤ 5 s p95 (sem mídia) e ≤ 15 s p95 (com mídia) em 80 msgs/s. | `processed_at − received_at` do inbox na bancada. |
| RNF-03 | Perda de mensagem = 0 sob restart forçado no meio de uma rajada de 1.000 mensagens. | Bancada: matar o processo durante a rajada; `count(messages)` = `count(inbox)` = 1.000. |
| RNF-04 | Chamadas ao banco por mensagem de texto ≤ 5 no `persist` (hoje 15–30). | Contagem por `pg_stat_statements` na bancada. |
| RNF-05 | Detecção de motor/cron parado ≤ 3 min e notificação ≤ 5 min. | Simular parada do cron: alerta chega ≤ 5 min. |
| RNF-06 | Concorrência do drenador fixa (8–16 conversas) e profundidade/idade da fila expostas. | `message_inbox_stats()` e métricas no Monitor. |
| RNF-07 | Nenhum worker/`setInterval` fora de requisição no app (Passenger). | Teste/lint que proíbe `setInterval` global em `src/lib/**` fora da allowlist (heartbeat do cron). |
| RNF-08 | Segredos do inbox: o `payload` nunca guarda token; RLS ligada e `REVOKE` de `anon/authenticated` (padrão da 185). | Teste PGlite de grants (`has_table_privilege`). |

## 6. Desenho proposto

### 6.1 Inbox durável de mensagens (alinhado à 185)

**Princípios:** gravar antes do 200 (uma chamada por POST); idempotência por UNIQUE; drenagem em lote por cron stateless + "chute" no `after()` com `try_claim` (~1×/s no cluster, como `try_claim_status_drain`); Meta e WAHA continuam bifurcados nos **parsers**; o inbox guarda evento normalizado por provedor.

```sql
-- rascunho (conferir o schema live antes de escrever a migration)
CREATE TABLE IF NOT EXISTS wacrm.webhook_message_inbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider        text        NOT NULL CHECK (provider IN ('meta','waha','social','webchat')),
  event_kind      text        NOT NULL CHECK (event_kind IN ('message','reaction','revoked','echo_out')),
  account_id      uuid        NOT NULL,
  channel_id      uuid        NOT NULL,      -- canal que validou o HMAC (nunca do corpo)
  message_id      text        NOT NULL,      -- wamid / id WAHA / mid social
  conv_key        text        NOT NULL,      -- channel_id || ':' || telefone normalizado
  event_ts        timestamptz NOT NULL,      -- horário do provedor
  payload         jsonb       NOT NULL,      -- 1 mensagem + contato + metadados mínimos, SEM token
  stage           smallint    NOT NULL DEFAULT 0,  -- 0 recebida, 1 persistida, 2 mídia ok, 3 efeitos
  state           text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','done','dead')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until     timestamptz, owner_id text, last_error text,
  message_row_id  uuid,
  received_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at    timestamptz,
  CONSTRAINT webhook_message_inbox_dedupe UNIQUE (provider, channel_id, message_id, event_kind)
);
-- índices: (next_attempt_at) WHERE state IN ('pending','processing'); (conv_key, event_ts, id) WHERE pendente; (processed_at) WHERE done/dead
-- RLS ligada; REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT ALL TO service_role (igual 185)
```

| Função | Papel |
|---|---|
| `ingest_message_events(p_events jsonb)` | `INSERT … SELECT FROM jsonb_to_recordset … ON CONFLICT ON CONSTRAINT webhook_message_inbox_dedupe DO NOTHING`. Uma chamada por POST, antes do 200. |
| `claim_message_inbox(p_owner, p_limit, p_lease '120 s')` | Uma "cabeça" por `conv_key` (menor `(event_ts, id)` pendente): `DISTINCT ON (conv_key) … FOR UPDATE SKIP LOCKED`; marca `processing`, `attempts+1`, lease. Ordem por conversa e vários drenadores sem colisão. |
| `persist_inbound_message(p_event_id)` | Estágio 1 numa transação: contato + conversa (`ON CONFLICT` do índice novo) + `INSERT messages … ON CONFLICT (message_id) DO NOTHING RETURNING id` + UPDATE da conversa com `GREATEST(last_message_at, …)` + unread + SLA em 1 round-trip. Devolve `{message_id, conversation_id, contact_id, was_created, is_first_inbound}`. Idempotente. |
| `complete_message_inbox` / `fail_message_inbox` | Conclui ou aplica backoff `30 s × 2^attempts` (teto 15 min); após 8 tentativas → `dead`. |
| `try_claim_message_drain(p_interval_ms)` | Mesmo padrão da 185 (`cron_locks`): o `after()` só drena se ganhar a vez (~1×/s); cron de 1/min é rede de segurança. |
| `message_inbox_stats()` | Profundidade por estado, idade do `pending` mais antigo, `dead`, tentativas médias. |

**Camada de aplicação:** (1) rota do Meta valida HMAC por canal, gera 1 evento por mensagem (casando `contacts[]` por `wa_id`, corrige WH-04), chama `ingest_message_events` e só então responde 200 — reaproveitando `status-inbox.ts` (extract/ingest/drain, detecção de função ausente PGRST202/42883 com recheck de 60 s). (2) Drenador `lib/whatsapp/message-inbox.ts`: `claim` → agrupa por conversa → processa conversas em paralelo (8–16) e eventos da mesma conversa em sequência → estágios `persist` (rápido, define a ordem), `media` (Meta: `getMediaUrl` fresco + download com teto por `Content-Length`; falha = retry sem bloquear a mensagem), `side_effects` (campanha-webchat, `dispatchInboundToFlows`, IA, automações — fluxo já é idempotente por `isDuplicateInbound`/índice 115, IA por `claim_ai_reply` (122), automações por marcador at-most-once). (3) `POST /api/whatsapp/inbox/cron` (segredo operacional, 1×/min) + `after()` com `try_claim`; pode ser chamado também do tick do Disparador (como `drainStatusInbox`, `disparador/cron/route.ts:383-387`). (4) WAHA no mesmo inbox; eco `fromMe` com `next_attempt_at = now()+3 s`. (5) Social no inbox; webchat continua gravando antes de responder e usa o inbox só para `side_effects` (+ `client_message_id`). (6) Debounce de IA/sentimento por `conversations.ai_due_at`/`sentiment_due_at` no mesmo cron.

**Decisões e alternativas descartadas:** (a) *Fila externa (Redis/SQS)*: descartada — o Supabase já é a fonte de verdade e o padrão 185 funciona; evita infra nova. (b) *Worker Node dedicado*: só como serviço separado no EasyPanel **se** a bancada mostrar que `after()+cron` não atinge RNF-02; não no Passenger. (c) *Processar inline e só "espelhar" no inbox*: é o modo `shadow` (6.7), usado para validar, não como destino. (d) *Unificar parsers Meta×WAHA*: proibido pela regra central.

### 6.2 Correções rápidas do webhook (sem inbox, baixo risco)
WH-03 (try/catch por mensagem e por change), WH-04 (`wa_id`), WH-06 (`button`/`order`/`contacts`/`value.errors`), WH-14 (reaproveitar canal verificado), WH-21 (dedupe antes do trabalho). Entram em PR próprio **antes** do inbox: reduzem dano imediato e são pré-requisito de limpeza do parser.

### 6.3 Observabilidade e alertas
Peças mínimas (nenhuma depende do mesmo banco para o alarme de "banco fora"):
1. `GET /api/health` (sem segredo, resposta curta): `{app:'ok', db:'ok'|'fail', version:<deploymentId>, ticks_age_s, log_failures}`; consulta barata. Alvo de monitor externo (UptimeRobot/Healthchecks.io) — o único que enxerga "app inteiro fora".
2. `wacrm.cron_status(job text pk, last_ok_at, last_error_at, last_duration_ms, last_error)`: cada rota de cron faz upsert no `finally` (1 linha por job; não infla o log).
3. `POST /api/ops/watchdog` (cron externo, a cada 1 min, `OPS_WATCHDOG_SECRET`): lê `cron_status`, `cron_tick`, 500s, `schema_migrations`, `message_inbox_stats()`; aplica limiares; deduplica em `wacrm.ops_alerts(key, opened_at, last_notified_at, resolved_at)`; reenvia a cada 30 min enquanto aberto.
4. Notificador `src/lib/ops/notify.ts`: Slack (`OPS_SLACK_WEBHOOK_URL`) e/ou WhatsApp via canal WAHA interno (já existe); e-mail como reserva. **Canal de notificação é decisão do dono (13.1).**
5. `x-request-id` gerado no proxy, propagado a `writeLog`/`console`, devolvido em header e no erro do front/API (`request_id`).
6. `withApiLogging(handler)` nas rotas novas e nas de maior volume (grava `api_error` em 500); `LogSource` ganha `'ops'` (com teste TS×CHECK, P-12).

**Limiares** (tabela completa na seção 10).

### 6.4 Crons (inventário a versionar)

| Rota | Frequência esperada | Segredo / header | Idempotência / lock | Se ficar parado |
|---|---|---|---|---|
| `POST /api/disparador/cron` (`:297-299,792`) | 60 s (com `DISPARADOR_TICK_CHAIN=1` encadeia hops via `after()`, `docs/disparador-tick-encadeado.md:14,20`) | `x-cron-secret`=`CRON_SECRET` (503 sem env) | `try_acquire_cron_lock('disparador_cron')` TTL 90 s, heartbeat 20 s (`:355-368`, mig. 184); locks próprios (retry, 131026, `disparador_metrics`) | Campanhas `em_execucao` param; itens `enviando` presos até o watchdog; só o Monitor avisa |
| `POST /api/disparador/prepare/cron` (`:13,22`) | a confirmar (13.1) | `CRON_SECRET` | lock `disparador_prepare` | Campanhas agendadas não são preparadas (também roda no tick se `DISPARADOR_PREPARE_IN_TICK`) |
| `POST /api/disparador/health/cron` (`:12-17`) | a confirmar (re-lê quem tem > ~4 min) | `CRON_SECRET` | lock `disparador_health` | Qualidade/tier envelhecem; `max_in_flight` por qualidade (190) usa dado velho |
| `POST /api/automations/cron` (`:12-17,22,80`) | a confirmar | `AUTOMATION_CRON_SECRET` | `status='running'` sem lease (P-17) | Esperas/atrasos de automação não retomam |
| `POST /api/flows/cron` (`:34-45,175`) | 5 min (doc) — risco de 1×/dia (P-03) | `AUTOMATION_CRON_SECRET` | sem lock | Runs abandonados travam o contato; watchdog de IA parado |
| `POST /api/conversations/retry-assignment` (`:6-15`) | a confirmar | `AUTOMATION_CRON_SECRET` (`timingSafeEqual` manual) | limite 100 + `assignment_retry_at` | Conversas `pending` sem agente |
| `POST /api/channels/refresh-tokens` (`:8-20`) | diário | `AUTOMATION_CRON_SECRET` | stateless, lotes de 50, janela 10 dias | Token do Instagram (60 dias) expira; canal cai |
| `POST /api/stress/run` | diário 02:00 (`tests/stress/README.md:38`) | `STRESS_RUN_SECRET` (503 sem env) | grava em `system_logs`; chama `disparador/cron` e `flows/cron` reais | Aba "Testes" do `/ddm-logs` sem histórico |
| `POST /api/whatsapp/inbox/cron` **(novo)** | 60 s | segredo operacional | `try_claim_message_drain` + `claim_message_inbox` | Mensagens aguardam o `after()` (latência), nunca se perdem |
| `POST /api/ops/watchdog` **(novo)** | 60 s | `OPS_WATCHDOG_SECRET` | dedupe em `ops_alerts` | Sem alarmes (cobrir com monitor externo no `/api/health`) |

`middleware.ts:188-199` libera sem sessão qualquer `/api/disparador/*` cujo caminho contenha `/cron` (substring; AP-10 do PRD 14): a proteção fica só no segredo da rota.

### 6.5 Migrations: registro e ordem
- `wacrm.schema_migrations(id text pk, applied_at timestamptz default now(), applied_by text, env text, checksum text, notes text)` (ex.: `id='188'`, `'187b'`). Cada migration nova termina com `INSERT … ON CONFLICT DO NOTHING`. Backfill por **um** script `scripts/ops/backfill-schema-migrations.mjs` que preenche o que o banco já tem (checando objetos: `to_regclass`/`to_regprocedure`/colunas), **revisado pelo dono antes de gravar** — o registro nunca é "palpite".
- `supabase/required-migrations.json`: ids exigidos pelo commit; `schema:check` compara com a tabela e substitui `EXPECTED_SCHEMA_VERSION`/`app_schema_version()` (P-04). CI falha em número duplicado novo (> 193) e em id fora de ordem.
- Coordenação de numeração: reservar faixas por PR no próprio arquivo `supabase/migrations/README.md` (quem pega o número publica antes) — resolve P-18 sem burocracia.
- Aplicar a mesma lista em produção (`cyftbffhgjmsfogxawrl`) e no Supabase de desenvolvimento (`omnichannel-v2-desenvolvimento`).

### 6.6 Ambientes, deploy, rollback, `proxy`
- **Ambientes:** `.env.production.example`, `.env.staging.example`, `.env.local.example` gerados da tabela de variáveis (seção 6.6.1). Staging = Supabase de teste (`omnichannel-v2-desenvolvimento`) + `.cpanel.yml`/`deploy.sh staging`; `docs/disparador-bancada-carga.md:11-20` já descreve um staging "só schema" para a bancada (o gate de `src/instrumentation.ts` aborta o boot se `DISPATCH_LOAD_TEST` for usado contra Meta real ou Supabase de produção — manter).
- **Deploy único:** `scripts/deploy.sh <prod|staging>`: `git pull` → `nvm use 20.19.0` → `npm ci` → `npm run schema:check` → `NEXT_DEPLOYMENT_ID=$(git rev-parse --short HEAD) npm run build` → `touch tmp/restart.txt`. Runbook: "evite deploy no pico; espere ~90 s do lock do cron" (P-19).
- **Rollback:** código = `git checkout <sha anterior>` + `deploy.sh` (as migrations são forward-compatible: toda migration deste ciclo é "antes ou depois do deploy", conforme o cabeçalho de cada uma, tabela 7.2). Migrations não têm "down": o rollback de dados é forward-fix. Isso entra em `docs/operations.md`.
- **Skew de versão:** `deploymentId` obrigatório (P-21).
- **Next 16:** `middleware`→`proxy` via codemod num PR dedicado, junto com a revisão do limite de corpo de 50 MB (AP-05, PRD 14) e a geração de `x-request-id` (6.3 item 5); `security-routes.test.ts` e `middleware.test.ts` como rede.

#### 6.6.1 Variáveis de ambiente (resumo; tabela completa vira `docs/env.md`)
Obrigatórias: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` (módulo carrega no boot; hoje sem validar 64 hex — S-13 do PRD 14), `CRON_SECRET` (disparador/prepare/health/start/stress; **falta no `.env.local.example`**), `AUTOMATION_CRON_SECRET` (automations/flows/refresh/retry), `META_APP_SECRET` (se Meta), `WAHA_WEBHOOK_SECRET` (se WAHA), `STRESS_RUN_SECRET` (se `stress/run`). Recomendadas: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `ALLOWED_INVITE_HOSTS`, `NEXT_DEPLOYMENT_ID`, `AUDIT_HEADER_SECRET` (≥ 32). Flags do motor (padrão desligado): `DISPARADOR_TICK_CHAIN`, `DISPARADOR_BATCH_CLAIM`, `DISPARADOR_PREPARE_IN_TICK`, `DISPARADOR_*`. Só staging/teste: `DISPATCH_LOAD_TEST`, `META_API_BASE_URL`, `OPENAI_BASE_URL`, `MOCK_*`, `LOAD_*`. Obsoletas: `DDM_LOGS_USER/PASSWORD`.

### 6.7 Flags e implantação do inbox
`WEBHOOK_MESSAGE_INBOX=off|shadow|on`. `off` = código atual. `shadow`: grava no inbox **e** continua processando inline como hoje, marcando `done` ao fim — mede latência, duplicatas e perdas **sem mudar o comportamento**. `on`: só inbox. Rollback = voltar a flag; o app detecta a ausência das funções (como na 185) e cai no caminho antigo.

### 6.8 API v1 — evolução do contrato
Ver seção 8 (contrato). Decisões: (i) janela 24h calculada com a mesma regra de `findOrCreateConversation` (`v1/whatsapp/send/route.ts:547-575`); (ii) código de erro estável por catálogo (`meta-error-catalog.ts`), nunca texto cru do provedor; (iii) idempotência: erro definitivo persiste a resposta de erro, incerto fica `reserved` com TTL e reconciliação; (iv) webhooks de saída com endpoints cadastráveis por chave, assinatura HMAC com timestamp, teto de tentativas e `dead`; (v) rate limit pela RPC compartilhada do PRD 14.

## 7. Dados e migrations

### 7.1 Propostas (numeração a coordenar; próximo livre hoje: 194)

| Nº (provisório) | O que faz | Ordem vs deploy | CONCURRENTLY | Rollback |
|---|---|---|---|---|
| 194 | `webhook_message_inbox` + funções (`ingest/claim/persist/complete/fail/try_claim/stats`) | ANTES do deploy do código que as chama (código tolera ausência, cai no caminho antigo) | não | `DROP` das funções/tabela (nada depende enquanto a flag está `off`) |
| 194b | índices do inbox (se criados após carga) | DEPOIS, sozinho | **sim** | `DROP INDEX CONCURRENTLY` |
| 195 | Índice único parcial de conversa aberta (WH-07) | Só depois de zerar duplicatas | **sim** (arquivo próprio) | `DROP INDEX CONCURRENTLY` |
| 196 | `messages.media_state`, `conversations.first_inbound_at`, `ai_due_at`, `sentiment_due_at` | antes ou depois (colunas nulas) | não | `ALTER TABLE … DROP COLUMN` |
| 197 | `schema_migrations` + `cron_status` + `ops_alerts` | antes ou depois | não | `DROP TABLE` |
| 198 | `api_webhook_endpoints` + `api_webhook_deliveries` (API-05) | antes | não | `DROP TABLE` |
| 199 | Índice parcial `system_logs (created_at DESC) WHERE event='cron_tick'` (P-11) | DEPOIS | **sim** | `DROP INDEX CONCURRENTLY` |

**Pré-checks (rodar antes e conferir):**
- WH-07: `SELECT account_id, contact_id, channel_type, COALESCE(config_id, channel_id) AS ch, count(*) FROM wacrm.conversations WHERE status <> 'closed' GROUP BY 1,2,3,4 HAVING count(*) > 1;` — resolver/mesclar duplicatas antes do índice.
- Inbox: `SELECT to_regclass('wacrm.webhook_status_inbox'), to_regprocedure('wacrm.try_claim_status_drain(integer)');` (185 aplicada).
- Estado de `messages`/`conversations`: `SELECT indexdef FROM pg_indexes WHERE schemaname='wacrm' AND tablename IN ('conversations','messages');` (definição de `idx_messages_message_id_unique`).

### 7.2 Migrations 160..193 (referência para ordem/aplicação)
Todas as de 160 a 193 estão catalogadas em `plataforma-ops` (notas de revisão); regras observadas: 160, 162, 163, 165, 167, 176, 177/180, 183, 184, 186, 188 → **ANTES** do deploy; 164, 168, 170, 171, 181, 187, 189, 190, 191, 192, 193 → **antes ou depois** (app detecta/tolera); CONCURRENTLY (arquivo sozinho): 168 (6 índices), 187b, 189b, 191b. Cabeçalhos de 184/186/188/190/192/193 trazem PRÉ-CHECK que lê a definição viva (`pg_get_functiondef`) — é o padrão a manter. Duplicadas: 113, 132, 133, 143; lacunas: 149, 151, 156. Marcador atual: `wacrm.app_schema_version()` = 143 (P-04). **O backfill de `schema_migrations` (6.5) responde, banco a banco, o que está aplicado — hoje só o live sabe.**

## 8. Contrato para o frontend

> Front é de outra pessoa; só consome. Envelope atual da API v1: sucesso `{data}`, erro `{error:{code,message,...}}`. Rotas internas (`/api/ops/*`, telas de admin) exigem sessão owner/admin (`requireDisparadorAccess`/`requireRole`).

### 8.1 Rotas novas internas (telas de operação)
| Rota | Método | Papel | Resposta | Uso no front |
|---|---|---|---|---|
| `/api/health` | GET | pública | `{app, db, version, ticks_age_s, log_failures}` | monitor externo; selo "sistema ok" no rodapé (opcional) |
| `/api/ops/status` | GET | owner/admin | `{crons:[{job, last_ok_at, age_s, status:'ok'\|'atrasado'\|'parado'}], inbox:{pending, oldest_pending_s, dead, processing}, alerts:[{key, severity, opened_at, message}]}` | painel "Saúde da plataforma" (aba no Monitor) |
| `/api/ops/inbox/dead` | GET | owner/admin | lista keyset de linhas `dead` (id, provider, canal, `message_id`, `last_error`, `attempts`, `received_at`) | tela de dead-letter |
| `/api/ops/inbox/dead/{id}/replay` | POST | owner/admin | `{ok:true, state:'pending'}`; auditado; 404 se de outra conta | botão "Reprocessar" |
| `/api/whatsapp/inbox/cron`, `/api/ops/watchdog` | POST | segredo operacional | `{ok, drained\|alerts_opened}` | só cron (sem tela) |

Erros: 401 sessão ausente, 403 papel, 404 recurso de outra conta, 409 estado inválido. Toda resposta com `Cache-Control: no-store` e `request_id`.

### 8.2 API v1 (integradores)
| Rota | Mudança | Payload/erro |
|---|---|---|
| `POST /api/v1/whatsapp/send` | **+** `channel` (UUID), **+** `template:{name,language,variables[]}`; janela 24h calculada | Sucesso 200 `{data:{whatsapp_message_id, conversation_id, channel_id, window:'open'\|'template'}}`. Erros novos: 422 `outside_window` (`details:{template_required:true}`), 422 `template_not_approved`, 400 `channel_ambiguous` (mais de um canal e `channel` ausente), 422 `recipient_invalid`, 503 `channel_paused`, 502 `provider_error` (`{provider_code, retryable}`). Idempotência: `Idempotency-Key` obrigatória; erro definitivo é **reproduzido** (mesmo corpo) no replay; 409 `provider_outcome_unknown` só para resultado incerto. |
| `GET /api/v1/messages/{id}` | **novo** (`messages:read`) | `{data:{id, status:'queued'\|'sent'\|'delivered'\|'read'\|'failed', provider_code, error:{code, retryable}, timestamps}}` |
| `GET /api/v1/disparador/campaigns/{id}/items?cursor=&limit=` | **novo** (`campaigns:read`) | keyset; cada item `{id, phone_masked?, status, error:{code, class, meaning}, updated_at}`; códigos do catálogo |
| `GET /api/v1/disparador/campaigns` | **novo** | lista keyset com status/métricas |
| `POST /api/v1/webhooks` / `GET` / `DELETE /{id}` | **novo** (`webhooks:write`) | `{url (https, SSRF-guard), events:['message.received','message.status','campaign.completed'], secret (devolvido 1 vez)}` |
| Webhook de saída | **assinado** | headers `X-CRM-Event`, `X-CRM-Delivery`, `X-CRM-Signature: t=<unix>,v1=<hex HMAC_SHA256(secret, t + "." + body)>`; receptor deve rejeitar `|now−t| > 5 min`; entregas com retry exponencial até 12 tentativas, depois `dead` visível em `GET /api/v1/webhooks/{id}/deliveries`. |
| Todas | `X-Request-Id` no header e `request_id` no corpo de erro; `RateLimit-Limit/Remaining/Reset` e 429 `rate_limited` com `Retry-After`; OpenAPI com `info.version`, `Sunset` e exemplos por código. |

Catálogo de códigos de erro v1 (estáveis, listados no OpenAPI): `unauthorized`, `forbidden`, `rate_limited`, `bad_request`, `not_found`, `recipient_blocked`, `recipient_invalid`, `outside_window`, `template_not_approved`, `channel_ambiguous`, `channel_paused`, `provider_error`, `conflict`, `payload_too_large`, `unavailable`, `internal`.

## 9. Testes e aceite

| Camada | O que prova | Onde |
|---|---|---|
| Unit | `parseMessageContent` (button/order/contacts/errors), resolução de contato por `wa_id`, backoff do drenador, mapeamento Meta→erro v1, assinatura HMAC de webhook de saída (+ janela de timestamp), `LogSource`×CHECK | vitest |
| Rotas | cron sem segredo→401/503 (parametrizado, as 10 rotas); webhook Meta/WAHA/social: falha de ingest→500, sucesso→200; `/api/health`; `/api/ops/*` por papel e conta | vitest com mocks (`route.test.ts` no padrão do repo) |
| PGlite (`*.sql.test.ts`) | `ingest_message_events` idempotente; `claim_message_inbox` entrega 1 cabeça por conversa e respeita lease; `persist_inbound_message` idempotente e `GREATEST`; índice único de conversa; dead-letter; grants (anon/authenticated sem acesso); `schema_migrations` | PGlite com `testTimeout` 30 s (P-08) |
| Bancada de carga (#132) | cenário "80 msgs/s de respostas": RNF-01..04; **kill -9 no meio da rajada** → perda 0 (RNF-03); medir chamadas/mensagem (`pg_stat_statements`) | `scripts/loadtest/*`, staging, manual até virar job noturno |
| Staging | `shadow` por 3–7 dias com tráfego real: divergência inbox×inline = 0, latência `processed_at−received_at` | Supabase de teste + canal de teste |
| CI | `v2` coberta; `schema-drift` (→14); regra ESLint/teste de grafo (→14); número de migration duplicado falha | `.github/workflows/ci.yml` |

**"Blindado" =** (a) RNF-03 verde na bancada; (b) shadow sem divergência; (c) alarme de parada disparado em simulação; (d) CI exige o check na `v2`; (e) `schema:check` reprova banco sem migration exigida.

## 10. Observabilidade

| Evento / sinal | Fonte | Limiar | Gravidade | Canal | Quem notifica |
|---|---|---|---|---|---|
| Motor do disparador parado | último `cron_tick` | > 180 s com campanha `em_execucao`; > 10 min em horário de janela | crítica | WhatsApp (plantão) + e-mail | watchdog |
| Cron de flows/automations/retry parado | `cron_status` | flows > 15 min; automations > 10 min; retry > 15 min; refresh-tokens > 26 h; prepare > 5 min com agendada pendente; health > 15 min; inbox > 3 min | alta | Slack/e-mail | watchdog |
| Inbox de mensagens atrasado | `message_inbox_stats()` | `pending` mais antigo > 60 s; `dead` > 0; profundidade crescente 5 min | alta | Slack | watchdog |
| Tick lento | `cron_tick.payload.duration_ms/budget_ms` | utilização > 90% por 5 ticks | média | Slack | watchdog |
| Event loop / RSS | `payload.event_loop_lag_p99_ms`, `rss_mb` | acima de `DISPARADOR_MAX_*` por 3 ticks | média | Slack | watchdog |
| Taxa de 500 em API | `api_error` (wrapper) | > 20/5 min ou > 2% | alta | Slack | watchdog |
| Falha de log | contador do `writeLog` | > 5/min | média | Slack | `/api/health` |
| Auto-pausa de campanha/número | `dispatch_auto_pause` | cada ocorrência | alta | WhatsApp ao responsável da conta | motor |
| Erros do provedor | `dispatch_errors_summary` | erro > X% em 10 min | alta | Slack | watchdog |
| Webhook Meta com assinatura inválida | `webhook_meta` | > 20/10 min | média | Slack | watchdog |
| `user_bug_report` | `feedback` | cada um | baixa | Slack suporte | `feedback/route.ts` |
| Tamanho de `system_logs` | `pg_total_relation_size` | limite a definir | média | e-mail semanal | watchdog |
| Migration pendente | `schema_migrations` × `required-migrations.json` | qualquer diferença | alta | Slack | `deploy.sh` |
| `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET=true` | env no boot | presente | média | Slack | `/api/health` (campo `flags_inseguras`) |

Métricas do inbox: profundidade por estado, idade do `pending`, taxa de retry, latência webhook→Inbox (`processed_at − received_at`), duplicatas absorvidas, erros por estágio, `dead`.

## 11. Riscos, rollback e plano de implantação

| Risco | Mitigação |
|---|---|
| Inbox novo muda ordem/duplica mensagens em produção | Flag `off→shadow→on`; shadow compara inbox×inline; rollback = voltar a flag (código detecta ausência de funções). |
| Índice único de conversa falha com duplicatas existentes | Pré-check obrigatório; migration aborta sem alterar; mesclagem manual/script antes. |
| Carga do drenador satura o pool do Supabase e atrasa o Disparador | Concorrência fixa 8–16; teste de 80 msgs/s na bancada; `claim` com limite; dimensionar com o limite de conexões do plano (13.11). |
| Regra de reabertura de conversa (WH-09) | Fora do escopo (REGRA DO DONO): manter a regra por canal como está; não há mudança prevista. |
| `middleware→proxy` quebra autenticação de borda | PR dedicado, `security-routes.test.ts`/`middleware.test.ts` como rede, teste manual de login e de POST anônimo de 40 MB. |
| Backfill errado de `schema_migrations` | Backfill por verificação de objetos + revisão do dono; tabela é informativa até o `schema:check` passar a exigi-la (2 etapas). |
| Alarme barulhento | Deduplicação em `ops_alerts`, limiares da seção 10, horário de plantão. |

**Ordem de implantação:** 1) F0 (docs/CI/vitest/env; sem risco de runtime) → 2) F1 (health/cron_status/watchdog) → 3) F2 (correções rápidas do webhook) → 4) F3 migration do inbox + código em `off` → 5) `shadow` em staging, depois produção → 6) `on` Meta → 7) WAHA/social/webchat → 8) API v1.

## 12. Fases e PRs

Tamanho: P ≤ 1 dia, M 2–4 dias, G > 4 dias. BE = backend, OPS = infraestrutura/dono do servidor. Todos os PRs com base `v2`, sem empilhar (cada um parte de `v2`).

| # | PR | Conteúdo | Dep. | Dono | Tam. |
|---|---|---|---|---|---|
| 15.1 | `ops-docs-ci` | `docs/crons.md` + `ops/crontab.example` + `docs/env.md` + `.env.*.example`; CI para `v2`/`release/*` + `node-version-file`; `vitest` timeouts/maxWorkers; remover fallback `mkrkkvbseobdqsalrorl`; README stress corrigido | — | BE+OPS | P |
| 15.2 | `deploy-script` | `scripts/deploy.sh <env>` (`npm ci`, `schema:check`, `NEXT_DEPLOYMENT_ID`), corrigir `.cpanel.yml`, runbook de deploy/rollback | 15.1 | OPS | P |
| 15.3 | `schema-migrations` | migration 197 (registro) + `required-migrations.json` + `schema:check` novo + backfill revisado + CI de número duplicado | 15.1 | BE+dono | M |
| 15.4 | `health-watchdog` | `/api/health`, `cron_status`, upsert nas rotas de cron, `/api/ops/watchdog`, `notify`, `ops_alerts`; request id; `withApiLogging`; testes parametrizados de cron (P-10) | 15.1, 13.1 | BE+OPS | G |
| 15.5 | `webhook-quickfixes` | WH-03/04/06/14/21 + testes | — | BE | M |
| 15.6 | `conversa-unica` | pré-check + mesclagem + índice único parcial (195, CONCURRENTLY) + função de resolução de conversa | 15.5 | BE+dono | M |
| 15.7 | `inbox-mensagens-core` | migration 194 + `lib/whatsapp/message-inbox.ts` + rota Meta em `off/shadow/on` + `persist_inbound_message` + `/api/whatsapp/inbox/cron` + dead-letter + `/api/ops/inbox/*` | 15.3, 15.4, 15.6 | BE | G |
| 15.8 | `inbox-midia` | estágio `media`, copiar todos os tipos para `chat-media/account-<id>/`, `media_state`, teto de download | 15.7 | BE | M |
| 15.9 | `inbox-waha-social-webchat` | WAHA e social no inbox, eco `fromMe` por `next_attempt_at`, `client_message_id` do webchat, teto de corpo, validar `entry.id` | 15.7 | BE | G |
| 15.10 | `debounce-persistido` | `ai_due_at`/`sentiment_due_at` + cron; remover `setTimeout` de IA/sentimento/acordo; marcador at-most-once de automações | 15.7 | BE | M |
| 15.11 | `bancada-mensagens` | cenário 80 msgs/s + kill -9 no `scripts/loadtest`; relatório RNF-01..04 | 15.7 | BE | M |
| 15.12 | `api-v1-send` | template + janela 24h + `channel` + erros estáveis + ledger sem chave presa + `X-Request-Id` + OpenAPI | 15.4 | BE | G |
| 15.13 | `api-v1-leitura` | `GET /messages/{id}`, itens de campanha (keyset), lista de campanhas, resposta de idempotência de campanha (API-10) | 15.12 | BE | M |
| 15.14 | `api-v1-webhooks` | endpoints cadastráveis, assinatura HMAC, retry com teto e `dead`, SSRF-guard, eventos `message.received/status` | 15.7, 15.12 | BE | G |
| 15.15 | `proxy-next16` | codemod `middleware→proxy`, `x-request-id`, revisão do limite de corpo (com PRD 14 AP-05/06) | 15.4 | BE | M |
| 15.16 | `ci-schema-drift` | job `schema-drift` e grafo `server-only` no CI (consome PRD 14) | PRD 14 | BE | M |
| 15.17 | `crons-confiaveis` | `automations/cron` com lease (P-17), `retry-assignment` com `matchesOperationalSecret`, índice `cron_tick` (199, CONCURRENTLY) | 15.4 | BE | P |

Dependências críticas: 15.7 depende de 15.6 (índice) e de 15.3/15.4 (para operar com segurança); 15.12–15.14 dependem do rate limit compartilhado (PRD 14).

## 13. Perguntas ao dono e itens "A confirmar no live"

### 13.1 Perguntas ao dono (decisão)
1. **Canal de alerta:** Slack, WhatsApp (grupo de plantão via canal WAHA interno), e-mail, ou combinação? Quem está de plantão e em que horário?
2. **Crontab real:** posso ter acesso (`crontab -l` em `grpia@server.ddmsrv.com` ou o agendador do EasyPanel) para versionar a lista exata? (ver 13.2-1)
3. **Sombra em produção:** aceita rodar o inbox em modo `shadow` por 3–7 dias antes de ligar (custo: carga extra pequena)?
4. **Serviço separado:** se a bancada mostrar que `after()+cron` não atinge RNF-02, aceita um serviço worker dedicado no EasyPanel (fora do Passenger) para drenar o inbox?
5. **Regra de conversa (*Decisão da operação*, 4.1):** a Meta abre **nova** conversa quando a última está `closed`; o WAHA **reutiliza**. Isso é regra de negócio: o PRD **não propõe mudança**; só registra o risco técnico (`convsList[0]` sem ordenação).
6. **API v1 e janela de 24h:** fora da janela, o `send` deve (a) recusar com `outside_window` ou (b) enviar template automaticamente quando `template` for informado? (proposto: recusar e exigir `template` explícito)
7. **Escopos sem rota:** `messages:read`, `contacts:*`, `conversations:read` — implementar ou esconder da UI até existirem? Há integrador dependendo hoje?
8. **Eventos de webhook de saída:** além de `campaign.completed`, quais eventos os integradores precisam (`message.received`, `message.status`, outros)?
9. **Mídia:** aceita copiar documentos/vídeos/stickers recebidos para o Storage (custo de armazenamento) para não depender da retenção de ~30 dias da Meta? (retenção/expurgo **fora do escopo**)
10. **Staging:** usamos o Supabase `omnichannel-v2-desenvolvimento` como staging oficial (com canal de teste Meta/WAHA)?
11. **Plano do Supabase:** limite de conexões/pool do PostgREST no plano atual (para dimensionar a concorrência do drenador).

### 13.2 A confirmar no live (comando/consulta exata)

| # | O que | Como confirmar | Item |
|---|---|---|---|
| 1 | Crontab real e frequências | `crontab -l` em `grpia@server.ddmsrv.com` / agendador do EasyPanel; checar `flows/cron`, `automations/cron`, `retry-assignment`, `refresh-tokens`, `prepare/cron`, `health/cron` | P-01, P-03 |
| 2 | Campo `calls` da Meta aponta para o Next ou para o serviço Go? | Painel de webhooks da Meta (campos assinados e URL) | WH-20 |
| 3 | Schema vivo de mensagens/conversas | `SELECT indexdef FROM pg_indexes WHERE schemaname='wacrm' AND tablename IN ('conversations','messages');` (inclui `idx_messages_message_id_unique`, global ou composto); e a query de duplicatas de conversa (7.1) | WH-07, WH-23 |
| 4 | 185 aplicada e cron de 1/min agendado | `SELECT to_regclass('wacrm.webhook_status_inbox'), to_regprocedure('wacrm.try_claim_status_drain(integer)');` + conferir o agendamento | WH-01 |
| 5 | Carga real por mensagem e mensagens perdidas | `pg_stat_statements` por rota; comparar entregas 200 do painel de webhooks da Meta com `messages` inbound/hora; procurar contatos/conversas sem mensagem | WH-15/16/01 |
| 6 | Dimensão do `[Unsupported message type:` e de mídia só no proxy | `SELECT count(*) FROM wacrm.messages WHERE content_text LIKE '[Unsupported message type:%';` e `… WHERE media_url LIKE '/api/whatsapp/media/%';` | WH-06, WH-13 |
| 7 | Workers do Passenger | `PassengerMaxPoolSize`/instâncias do EasyPanel | API-04, WH-11, AP-03 |
| 8 | Ledger e outbox presos | `SELECT state, count(*), min(created_at) FROM wacrm.send_operations GROUP BY 1;` e `SELECT count(*), max(attempts) FROM wacrm.campaign_callback_outbox WHERE state='pending';`; `automation_pending_executions` com `running` antigos | API-03, API-05, P-17 |
| 9 | Chaves de API e escopos | `SELECT scopes, count(*) FROM wacrm.api_keys WHERE revoked_at IS NULL GROUP BY 1;` | API-07 |
| 10 | Tamanho/crescimento do `system_logs` e `cron_tick`/dia | `SELECT pg_size_pretty(pg_total_relation_size('wacrm.system_logs'));` e contagem por dia de `event='cron_tick'` | P-11 |
| 11 | Limites de conexão do Supabase | Painel do projeto (plano, pooler) | WH-16 |
| 12 | Migrations aplicadas por banco | `SELECT wacrm.app_schema_version();` e `to_regclass`/`to_regprocedure` de cada objeto 144–193 em produção e no Supabase de desenvolvimento; validade de índices: `SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE indexrelid::regclass::text IN ('idx_dmq_erro_codigo','idx_dmq_session_agendado','idx_dmq_erro_updated');` | P-04, P-18 |
| 13 | Timeout do proxy para `/api/disparador/cron` (≥ 60 s) e flags `DISPARADOR_TICK_CHAIN`, `DISPARADOR_BATCH_CLAIM`, `DISPARADOR_PREPARE_IN_TICK` | Variáveis do EasyPanel + teste de `curl` com `--max-time` | 6.4 |
| 14 | `global-error.tsx`/`error.tsx` enviam ao `/api/telemetry`? agregação de 500 em painel externo? | Ler o handler + logs do Passenger | P-13 |
| 15 | Warnings do `next build` e `NEXT_DEPLOYMENT_ID` no servidor (build roda com `.git`?) | Rodar o build no servidor e inspecionar | P-07, P-21 |
| 16 | Variáveis definidas em produção e dev | Painel do EasyPanel (`CRON_SECRET`, `AUDIT_HEADER_SECRET`, `WAHA_WEBHOOK_SECRET`, flags `DISPARADOR_*`) | P-15 |
| 17 | WAHA: retries/timeout do webhook da instância | Config da instância `api.meuchatia.com.br` | WH-08 |
| 18 | CI/branch protection | Último run verde em `main`; proteção em `main` e `v2`; duração do `npm test` | P-05, P-08 |
