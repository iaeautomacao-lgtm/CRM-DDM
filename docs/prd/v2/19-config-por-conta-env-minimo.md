# 19 — Configuração por conta e `.env` mínimo (V2 backend)

> Base: branch `v2` (`origin/v2` @ `66b3ad0`, 08/10/2026), worktree `wt-codex`. Revisão **somente leitura** (nada executado; sem acesso ao banco/servidor live). Linhas conferidas no código atual; o que só o ambiente real responde está em **"A confirmar no live"**. **Nenhum valor de segredo foi lido ou copiado.** Fonte: `inventario-env.md` (117 variáveis, classificação mecânica do Prisma — **tem erros**, corrigidos na seção 3.2).
> Regras que valem aqui: plataforma self-service (princípio do dono, 08/10) · **só V2** (toda branch parte de `origin/v2`, todo PR tem base `v2`) · **não mexer em negócio** (prompt, textos da IA, quando encerrar/handoff, acordo, cobrança → só "Decisão da operação", seção 4.1) · Meta×WAHA nunca unificados · migrations manuais, idempotentes, com pré-check · sem worker em memória no Passenger · retenção fora do escopo · migrations deste PRD: faixa **230–239**.
> Relacionado: PRD 14 (rotação de `ENCRYPTION_KEY`, cofre, rate limit compartilhado, SW-3/SW-4 de webhooks) e PRD 15 (flags de implantação, crons, `deploy.sh`, `.env.*.example`). Este PRD define **onde cada variável mora** e como migrar; os outros dois definem **como proteger/operar**.

## 1. Resumo

- **Problema:** o `.env` de produção reúne ~117 nomes: segredos de plataforma, **credenciais e links de cliente** (chaves de LLM, token DDM, `UTM_API_KEY`), parâmetros de desempenho, flags de implantação e variáveis de teste de carga. Para um cliente novo funcionar hoje, alguém precisa editar o servidor — contra o modelo "plataforma para outras empresas". Há ainda inconsistências (a chave da plataforma vence a da conta no chat de inteligência; o responder nativo da DDM ignora o cofre; duas versões da Graph API; `OPENAI_BASE_URL` esquecida em produção redirecionaria chamadas).
- **Objetivo:** `.env` **só com o essencial da plataforma** (Supabase, `ENCRYPTION_KEY`, segredos de cron/infra, URL do app, flags temporárias com critério de remoção). Tudo de cliente na **tela, por conta**, no banco, com papel e auditoria; parâmetros de operação da plataforma em **`platform_config`** (banco, auditado) ou constante de código.
- **Ganho:** onboarding de cliente sem tocar no servidor; um único resolvedor de chave de LLM (fim das 4 ordens de fallback divergentes); superfície de vazamento menor (menos segredos de cliente no `.env`); ajustes de incidente (timeouts, concorrência) sem deploy.
- **Escopo técnico, sem negócio:** valores padrão **não mudam**; só muda *onde* são lidos. Textos de IA/acordo/handoff ficam com a operação (4.1).

## 2. Estado atual

### 2.1 O que já existe por conta (reaproveitar)

| Armazenamento | Onde | Quem edita / papel | Auditoria | Observação |
|---|---|---|---|---|
| Cofre `wacrm.account_secrets` (`variable` texto / `credential` cifrada com `allowed_hosts` obrigatório) | migration `175_account_secrets.sql`; API `src/app/api/settings/secrets/route.ts:28` (GET supervisor+, mascarado) e `:45` (POST admin+), `[id]`; tela `src/components/settings/secrets-settings.tsx` | owner/admin escreve | trigger `audit_generic_changes` sem valores | Hoje só alimenta `{{cred/var/secret.X}}` em **tools HTTP** do agente (`src/lib/ai/account-secrets.ts:31`, `tool-secrets.ts:128-158`). **Nenhuma variável de ambiente deste PRD é lida dele.** Credencial exige `allowed_hosts` (`account-secrets.ts:61`): serve para "enviar ao host X", não para "chave do provedor" |
| `wacrm.ai_config` (`api_key` cifrada, `elevenlabs_api_key`, `api_provider`, `api_model`) | `src/app/api/account/ai-config/route.ts` (`guardRole('admin')` `:59`; grava `encrypt()` `:228-234`; GET mascara `:101-114`) | admin+ | a confirmar no live (trigger genérico?) | **Uma** chave por conta, atrelada ao provedor escolhido. ElevenLabs só existe por conta (sem env): o modelo do que as outras deveriam ser |
| `wacrm.whatsapp_config` (`access_token`, `app_secret`, `verify_token` cifrados; `waba_id`, `phone_number_id`) | `src/app/api/whatsapp/config/route.ts` (admin+ `:361-369`; `app_secret` obrigatório no 1º save `:722`) | admin+ | a confirmar | já é "por canal" |
| `wacrm.channels` (Instagram/Messenger: token, `external_id`, expiração) | `src/lib/channels/*`, `src/app/api/channels/*` | owner/admin conecta | a confirmar | só o **token** é por canal; app id/secret são globais (env) |
| Limites por número e limite/s | `dispatch_channel_limits`, `dispatch_channel_rate`, rotas `/api/disparador/limits` e `/rate-limits` | owner/admin | `logAuditEvent` antes/depois | já substitui `DISPARADOR_PER_NUMBER_*` em produção |
| **Não existe** | tabela `platform_*`/`system_settings` (grep em `supabase/`, `src/`, `docs/`: nada); papel de "operador da plataforma"; config por conta de teto/modelo do Intelligence | — | `logAuditEvent` exige `accountId` (`log-event.ts:19`) | precisam ser criados |

### 2.2 Cadeias de fallback de chave de LLM hoje (divergentes)

1. **Texto (responder):** `ai_config.api_key` da conta → env do provedor (`OPENAI`/`CLAUDE|ANTHROPIC`/`GEMINI`/`OPENROUTER`) → `failed/missing_provider_api_key` (`responder.ts:900-924`; `llm-shared.ts:53-65` devolve `null` = "pular análise").
2. **Chat de inteligência:** **env OPENAI → chave da conta → null** (`intelligence/chat/route.ts:64`) — ordem **inversa** à do responder.
3. **Whisper/STT:** chave da conta só se o provedor é OpenAI; senão **só env** (`responder.ts:932`).
4. **Disparador IA** (`dispatch-ai.ts:36`): `DISPARADOR_OPENAI_API_KEY` → `OPENAI_API_KEY` → null; **nunca olha a conta**; cliente OpenAI memoizado por chave (`:20`).
5. **DDM nas tools:** credencial da conta `DDM_TOKEN` vence o env (`tool-secrets.ts:138-146`); **no responder nativo** `ddmApiToken()` lê **só o env** (`responder.ts:104,1365`) e ignora o cofre.
6. **Assinatura WhatsApp:** `whatsapp_config.app_secret` do canal → `META_APP_SECRET` global → 401 (`webhook/route.ts:289-298,455-457`). **Assinatura Instagram/Messenger:** só env (`INSTAGRAM_APP_SECRET ?? META_APP_SECRET`, `meta/webhook/route.ts:49-50`).

### 2.3 Quando cada parâmetro é lido (decide se pode vir do banco)
Todas as AJUSTE/FLAG do disparador e da IA são lidas **por tick ou por requisição**, não no import (`resolveThroughputConfig()` em `cron/route.ts:337`, `autoPauseConfigFromEnv()` `:338`, `resolveTickChainConfig()` `:323/:790`, `isBatchClaimEnabled()` `:515`, `isPrepareInTickEnabled()` `:429`) — trocar a fonte por um snapshot do banco carregado no início do tick **não perde "vale no próximo tick"**. Exceções lidas **no import**: `META_GRAPH_VERSION` (`lib/channels/graph.ts:14`) e as bases de URL da bancada (`meta-api.ts:18`, `gate.ts:98-103`).

### 2.4 Cache já aceito no projeto (modelo para o snapshot)
`monitor-snapshot.ts:696-710` (2,5 s por conta, dedupe de leituras em voo), `blacklist-keys.ts:34-65` (60 s), canal do webhook `APP_SECRET_CACHE_TTL_MS = 60_000`; limites por canal lidos **uma vez por tick** (`cron/route.ts:110-150`, 4 queries em paralelo, tolera migration ausente).

## 3. Problemas e riscos

### 3.1 Problemas

| ID | Sev. | Onde (arquivo:linha) | Problema | Cenário de falha | Correção |
|---|---|---|---|---|---|
| ENV-01 | **ALTA** | `intelligence/chat/route.ts:64` | Chave do **env vence** a chave da conta (ordem inversa do responder) | Cliente com chave própria tem o consumo cobrado na chave da plataforma; com o env removido, a conta com chave perde o chat | Resolvedor único `resolveLlmKey` (conta → plataforma opcional → erro) |
| ENV-02 | **ALTA** | `dispatch-ai.ts:36`; `responder.ts:932` | Disparador IA **nunca olha a conta**; Whisper só usa env quando o provedor não é OpenAI | Cliente self-service sem env não tem IA no disparador nem transcrição | Resolvedor único com `purpose` (`text`, `stt`, `dispatch`, `intelligence`) |
| ENV-03 | **ALTA** | `responder.ts:104,1365` | Responder nativo da DDM lê **só env** e ignora o cofre; aliases `DDM_ACORDOS_API_TOKEN`/`DDM_TOKEN`/`DDM_API_KEY` | Consulta/formalização DDM desativada para conta sem env; token de cliente no `.env` | `ddmApiToken()` com `accountId` → cofre (`DDM_TOKEN`) → env (prazo) |
| ENV-04 | **ALTA** | `lib/disparador/dispatch-ai.ts:20`; `lib/intelligence/chat/openai-client.ts:53` | `new OpenAI({apiKey,…})` **sem `baseURL`**: o SDK lê `OPENAI_BASE_URL` sozinho, **contornando o gate** de carga (`gate.ts:41-45`) | `OPENAI_BASE_URL` esquecida no `.env` de produção redireciona chamadas (e a chave) para outro host | Passar `baseURL: resolveOpenAiBaseUrl()` explícito; proibir a variável em produção |
| ENV-05 | MÉDIA | `app/api/whatsapp/templates/[id]/route.ts:42-43`; `.../submit/route.ts:162-163` | `WHATSAPP_TEMPLATES_DRY_RUN=true` em produção grava `meta_template_id` **sintético** e não chama a Meta | Template "aprovado" que nunca existiu | Ignorar quando `NODE_ENV==='production'`; remover do `.env` |
| ENV-06 | MÉDIA | `intelligence/chat/route.ts:129`; `store.ts:20-23` | `INTELLIGENCE_MODEL` e teto diário são globais; contagem já é por conta | Cliente com chave própria preso ao modelo/teto da plataforma | Config por conta com teto da plataforma como limite |
| ENV-07 | MÉDIA | `external-urls/route.ts:5-6`; `lead-extractor/page.tsx:11,14-18` | `LEAD_EXTRACTOR_URL` tem URL da DDM **fixa no código** (2 lugares); `DISPARADOR_URL` é devolvida e **ignorada** | Cliente novo vê link do extrator da DDM | Link por conta (vazio = item de menu oculto); remover `DISPARADOR_URL` |
| ENV-08 | MÉDIA | `meta-api.ts:15` (v21.0) vs `channels/graph.ts:14` (v25.0 por env); `templates/sync/route.ts:26` (cópia de v21.0) | Duas versões da Graph API em produção; `META_API_VERSION` **não existe como variável** (constante duplicada) | Quem exportar `META_API_VERSION` acha que mudou algo e nada acontece | Uma constante por superfície em `lib/meta/versions.ts`, sem env |
| ENV-09 | MÉDIA | `invitations/route.ts:95`; `waha-webhook-auth.ts:46` | `NEXT_PUBLIC_SITE_URL` duplica `NEXT_PUBLIC_APP_URL`; `ALLOWED_INVITE_HOSTS` só vale sem `SITE_URL` | Duas URLs "canônicas" divergem; convite com host da requisição (AP-14 do PRD 14) | Unificar em `NEXT_PUBLIC_APP_URL`; falhar fechado |
| ENV-10 | MÉDIA | `.env.local.example` (36 de 117 nomes) | Exemplo mistura essenciais, chaves de cliente, flags e teste; **não documenta `CRON_SECRET`**; texto desatualizado (`DISPATCH_PROCESS_CONCURRENCY` "1..50", código 1..150) | Ambiente novo sobe sem `CRON_SECRET` (disparador 503) | Reescrever em 3 blocos (essenciais, flags com prazo, "não usar em produção") |
| ENV-11 | MÉDIA | `agents/schema.ts:52`; `convert.ts:138-142`; `service.ts:144-161` | `connections.*.platform_env` só **declara** nomes de env aceitos como fallback; nenhum leitor de runtime achado | Campo promete fallback que não existe; com env retirado vira ruído | Virar "fallback da plataforma: sim/não" (decisão do dono) ou remover |
| ENV-12 | MÉDIA | `agents/convert.ts:109-135`; `scripts/convert-ai-nodes-to-agents.mjs:237` | A conversão **congela o env** no perfil (`stall_*`, `knowledge.max_chars`, `execution.*`) e no **hash da versão** (`hashAgentVersion :47-49`) | Hash do perfil muda conforme o ambiente de quem roda o script | Gravar os padrões do schema, não o env |
| ENV-13 | MÉDIA | `ai-watchdog.ts:47-48` | O watchdog lê **só env**; `behavior.stall_seconds` do perfil não tem efeito | Campo da tela sem efeito | Decisão da operação (4.1); aqui só a fonte |
| ENV-14 | BAIXA | `meta/webhook/route.ts:49` | `INSTAGRAM_APP_SECRET ?? META_APP_SECRET`: cai no secret do app Facebook mesmo que o app Instagram seja outro | Aceita/rejeita assinatura errada conforme o app | Segredo por app, sem fallback cruzado |
| ENV-15 | BAIXA | `.env.local.example:156-157`; `docs/configuration.md:85-86` | `DDM_LOGS_USER`/`DDM_LOGS_PASSWORD` **sem leitor** (a rota usa `requireRole`, `ddm-logs/route.ts:4`) | Credencial "de suporte" fantasma | Remover do exemplo/docs |
| ENV-16 | BAIXA | `disparador/backend/src/common/guards/jwt-auth.guard.ts:21` | `DISPATCH_SINGLE_ACCOUNT_ID` é do serviço Nest legado, não do app Next | Parece configuração do app | Sai junto com o serviço legado |
| ENV-17 | BAIXA | `loadtest/gate.ts:31` | `SUPABASE_URL` só é lida pelo gate de carga | — | Fora do `.env` de produção |
| ENV-18 | BAIXA | `stress/run/route.ts:329-358` | `STRESS_API_KEY` é a chave pública v1 de uma conta de teste do health check | Chave de teste no `.env` | A rota cria/acha a chave da conta de teste (PRD 15) |
| ENV-19 | BAIXA | `WAHA_WEBHOOK_SECRET` (`waha-webhook-auth.ts:26,64,79`) | Classificado CLIENTE no inventário: é **segredo mestre de plataforma** (HMAC por canal, nunca enviado ao WAHA) | Mover para "cofre da conta" quebraria o desenho de HMAC por canal | Classificar INFRA; fica no `.env` |
| ENV-20 | BAIXA | `NEXT_DEPLOYMENT_ID` (`next.config.ts:17`), `PORT` (`app.js:11`), `VOIP_AUDIO_ALLOWED_HOSTS` (Go) | Lidas e **fora do inventário** | `.env` incompleto no exemplo | Documentar como INFRA |

### 3.2 Correções ao inventário mecânico (valores e classes)

| Variável | Inventário diz | Código diz | Efeito |
|---|---|---|---|
| `META_API_VERSION` | AJUSTE v21.0 | **não é env**: constante `'v21.0'` em `meta-api.ts:15` e `templates/sync:26` | sai da lista |
| `META_TIMEOUT_MS` | 20 s | **30 000** (teto 120 000) `meta-api.ts:20-26` | padrão correto |
| `DISPARADOR_AUTO_PAUSE_*` | janela 50, mín. 20, taxa 15%, incerto 3 | janela **100**, mín. **50**, taxa **0,30**, incerto **20** em 60 s (`auto-pause.ts:49-56`) | padrão correto |
| `AI_KB_MAX_CHARS` | 12 000 | **40 000** (`kb-context.ts:14`, `agents/schema.ts:216`); superada pelo perfil (`responder.ts:1119`) | REMOVER |
| `INTELLIGENCE_DAILY_MAX_MESSAGES` | 50 | **200** (`store.ts:11,20-23`) | padrão correto |
| `DISPATCH_PROCESS_CONCURRENCY` | máx. 150 | clamp 1..150 (`concurrency.ts:34-35,66`); comentário e exemplo dizem 50 | doc desatualizada |
| `WAHA_WEBHOOK_SECRET` | CLIENTE | **INFRA** (mestre de HMAC por canal) | muda destino |
| `STRESS_API_KEY`, `LOAD_API_KEY` | CLIENTE | SCRIPT-TESTE | fora do `.env` |
| `META_API_BASE_URL`, `OPENAI_BASE_URL`, `SUPABASE_URL`, `NODE_ENV`, `LOAD_*`, `MOCK_*` | INFRA | SCRIPT-TESTE (só valem com `DISPATCH_LOAD_TEST=1` ou em testes) | fora do `.env` |
| `LEAD_EXTRACTOR_URL`, `DISPARADOR_URL` | INFRA | link/config de conta (`DISPARADOR_URL` morta) | muda destino |
| `DDM_LOGS_USER/PASSWORD`, `DISPATCH_SINGLE_ACCOUNT_ID` | INFRA | sem leitor no app Next | REMOVER |
| `NEXT_PUBLIC_SITE_URL` | INFRA | duplica `NEXT_PUBLIC_APP_URL` | consolidar |
| `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY`, `DDM_TOKEN`/`DDM_API_KEY` | CLIENTE | **aliases** (note: `DDM_TOKEN` também é o **nome** do marcador `{{secret.DDM_TOKEN}}`; o nome do marcador fica, a env sai) | REMOVER alias |
| Fora do inventário | — | `NEXT_DEPLOYMENT_ID`, `PORT`, `VOIP_AUDIO_ALLOWED_HOSTS`, `NEXT_TELEMETRY_DISABLED` (CI) | acrescentar |

## 4. Objetivos e não-objetivos

**Objetivos**
1. `.env` de produção reduzido ao essencial (seção 6.1: ~14 nomes + flags temporárias com data/critério).
2. Toda credencial/link/limite **de cliente** em tela, por conta (cofre `provider_key` ou `account_settings`), com papel owner/admin e auditoria.
3. Parâmetros de operação **da plataforma** em `platform_config` (banco, snapshot com TTL, auditado) ou constante de código — sem deploy para ajustar incidente.
4. Um resolvedor único de chave de LLM e um único caminho para o token DDM.
5. Migração **sem downtime**: precedência `banco > env > padrão` durante a convivência, com prazo de remoção por variável e relatório de "quem ainda lê env".
6. Recomendar o modelo de app Meta (seção 6.5) e deixar a decisão ao dono.

**Não-objetivos:** mudar valores padrão; mexer em prompts/textos/regras de IA, handoff, acordo ou cobrança (4.1); unificar Meta×WAHA; retenção; frontend (só contrato, seção 8); reimplementar o cofre (175) — só estendê-lo.

### 4.1 Decisão da operação (REGRA DO DONO, 08/10) — sem requisito nem PR

| Item (negócio) | Risco técnico observado (e só isso) | Onde |
|---|---|---|
| Tempo de espera para considerar a IA "travada" e acionar handoff (`AI_STALL_SECONDS`=180, `AI_STALL_MAX_MINUTES`=30) | O watchdog lê só env; o campo `behavior.stall_seconds` do perfil não tem efeito. **Este PRD só move a *fonte* do valor (mesmos padrões)**; *qual* valor e se vale por agente é da operação | `ai-watchdog.ts:34-48`; `agents/schema.ts:200` |
| Limiares de pausa automática do disparador (taxa de erro, janela) | São proteção da **reputação do número**; mover a fonte não altera o padrão. Se a plataforma permitir override por conta, só **mais rígido** (nunca abaixo do piso) — a regra de quais valores usar é da operação | `auto-pause.ts:49-72` |
| Qual provedor/modelo cada cliente usa e o conteúdo do prompt | Fora de escopo; aqui só *onde mora a chave* | `ai_config`, `responder.ts` |
| Se a DDM oferece IA "da casa" (chave da plataforma como fallback) a clientes | Decisão comercial; o PRD descreve as duas opções técnicas (6.2) e pergunta | ENV-01, pergunta 13.2 |

## 5. Requisitos (com critério de aceite)

### 5.1 Funcionais

| ID | Requisito | Aceite |
|---|---|---|
| RF-01 | `platform_config` (tabela + histórico + registro em código) com `source` por chave (`db`\|`env`\|`default`), validação por faixa e `reason` obrigatório; snapshot em memória TTL 15–30 s, stateless | Teste unitário do snapshot (TTL, dedupe, stale-while-error, tabela ausente → env → padrão); PGlite da RPC `set_platform_config` (histórico na mesma transação, RLS fechada) |
| RF-02 | Trilha de auditoria de plataforma (sem `accountId`) | `platform_audit_logs` recebe antes/depois e motivo; nenhum valor sensível |
| RF-03 | Papel de **operador da plataforma** distinto de owner/admin de conta, só ele escreve `platform_config` | Teste de rota: owner/admin de conta → 403; operador → 200 |
| RF-04 | `account_settings` (chave/valor tipado por registro) editável por owner/admin com `logAuditEvent` | Teste de rota por papel e por conta; valor acima do teto da plataforma → 422 |
| RF-05 | `account_secrets.kind='provider_key'` (sem `allowed_hosts`) para chaves de provedor, **nunca** resolvível por `{{cred/secret}}` nas tools | Teste: `loadAccountSecrets` ignora `provider_key`; marcador `{{cred.LLM_OPENAI_API_KEY}}` → "ausente"; CHECK de `kind` aceita o novo valor |
| RF-06 | `resolveLlmKey(db, accountId, purpose)` único (`text`, `stt`, `dispatch`, `intelligence`): conta (cofre) → `ai_config.api_key` (legado) → chave da plataforma **somente se** `ai.platform_key_fallback` ligado → erro explícito | Testes por propósito e por provedor; chat de inteligência passa a conta-primeiro; `dispatch-ai` recebe `accountId`; Whisper lê a conta |
| RF-07 | `ddmApiToken(accountId)` lê cofre `DDM_TOKEN` (host fixo `ddmacordos.com`) → env (prazo) | Teste: conta com credencial funciona sem env; sem nenhuma → erro explícito atual |
| RF-08 | `UTM_API_KEY` por conta (cofre `provider_key`) e erro orientando a tela | Teste: sem chave → mensagem aponta a tela; chave da conta enviada como `X-API-Key` |
| RF-09 | Link do extrator de leads por conta (`account_settings`), vazio = oculto; `DISPARADOR_URL` removida | Teste de `external-urls`; sem a URL padrão da DDM no código |
| RF-10 | `INTELLIGENCE_MODEL` e `INTELLIGENCE_DAILY_MAX_MESSAGES` por conta, com padrão/teto da plataforma | Teste: conta > plataforma > padrão (200); acima do teto → 422 |
| RF-11 | Os parâmetros da tabela 6.3 passam a vir de `platform_config` com a precedência `banco > env > padrão` e os mesmos clamps | Testes existentes (`throughput-config.test`, `auto-pause.test`, `llm-gate.test`) passando um objeto com a mesma forma |
| RF-12 | Relatório de origem efetiva (`GET /api/platform/env-report`): por variável, `source` e se o env ainda é lido; log de boot das variáveis **ainda lidas do env** (só nomes) | Teste: variável só no env → `source:'env'`; no banco → `db`; nenhum valor impresso |
| RF-13 | Constantes de código para as variáveis marcadas (`lib/meta/versions.ts` etc.) e remoção das leituras de env | `grep process.env.<NOME>` = 0 nos módulos listados |
| RF-14 | `OpenAI` com `baseURL` explícito nos 2 construtores; `OPENAI_BASE_URL`/`META_API_BASE_URL` ignoradas fora de `DISPATCH_LOAD_TEST=1` | Teste do gate; construtor sem `baseURL` falha lint (regra) |
| RF-15 | `.env.production.example` mínimo + `.env.staging.example` + bloco "não usar em produção" (PRD 15 §6.6.1) | Diff do exemplo: só os nomes da seção 6.1 |

### 5.2 Não funcionais

| ID | Requisito | Aceite |
|---|---|---|
| RNF-01 | Nenhuma leitura de banco por envio/por chamada de LLM no caminho quente: snapshot **síncrono** (`getPlatformConfigSync`) carregado no início do tick/rota | Contagem de queries por tick inalterada (+1 por processo a cada TTL) |
| RNF-02 | Mudança vale em ≤ TTL (30 s) ou "no próximo tick" | Teste com relógio injetável |
| RNF-03 | Falha do banco nunca derruba o tick (mantém último snapshot válido; sem nenhum → env → padrão) | Teste de injeção de falha |
| RNF-04 | Segredo nunca volta ao navegador, nunca é logado, é cifrado (AES-256-GCM; AAD e anel de chaves do PRD 14 §6.3) | Teste de resposta mascarada; varredura de logs |
| RNF-05 | Migração sem downtime: código novo + banco antigo funciona (cai no env), banco novo + código antigo não quebra | Teste PGlite de migrations idempotentes; ordem "antes do deploy" |
| RNF-06 | Nenhum worker/`setInterval` novo (Passenger) | Revisão + lint |

## 6. Desenho proposto

### 6.1 As três camadas e o `.env` final

| Camada | O que mora | Edita | Auditoria |
|---|---|---|---|
| **1. `.env` (essencial da plataforma)** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` (→ `ENCRYPTION_KEYS` no PRD 14), `CRON_SECRET`, `AUTOMATION_CRON_SECRET` (pergunta 13.6: unificar), `AUDIT_HEADER_SECRET`, `STRESS_RUN_SECRET` (se mantiver o health check), `WAHA_WEBHOOK_SECRET` (se WAHA), **app Meta da plataforma** (`META_APP_ID`, `META_APP_SECRET`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` — enquanto a opção recomendada 6.5 estiver na fase 1), `NEXT_PUBLIC_APP_URL`, `DISPARADOR_CHAIN_URL` (opcional, loopback), `SSRF_ALLOWED_HOSTS` (opcional, segurança da plataforma), `VOIP_URL`/`VOIP_SERVICE_SECRET` (se VoIP), `NEXT_DEPLOYMENT_ID`, `PORT`, `DISPARADOR_MAX_RSS_MB` (opcional; propriedade da máquina) | operação/infra (acesso ao servidor) | log de implantação |
| **2. `platform_config` (banco)** | Parâmetros de operação não secretos da plataforma (tabela 6.3) e kill switches | **operador da plataforma** (papel novo), com `reason` | `platform_audit_logs` (antes/depois) |
| **3. Por conta (banco)** | **Cofre** `provider_key` (chaves de LLM, UTM, token DDM, app Meta próprio) e `account_settings` (modelo/teto do Intelligence, link do extrator, overrides permitidos) | owner/admin da conta | `logAuditEvent` + trigger do cofre |
| **Flags temporárias** (`.env`, com data) | `DISPARADOR_TICK_CHAIN`, `DISPARADOR_BATCH_CLAIM`, `DISPARADOR_PREPARE_IN_TICK`, `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET`, `WEBHOOK_MESSAGE_INBOX` (PRD 15) | operação | critério de remoção em 6.4 |

**Fora do `.env` de produção (scripts/testes):** `DISPATCH_LOAD_TEST`, `LOAD_*`, `MOCK_*`, `IMPORT_LOAD_*`, `METRICS_LOAD_INCREMENTS`, `META_API_BASE_URL`, `OPENAI_BASE_URL`, `SUPABASE_URL`, `RUN_LIVE_LLM`, `LIVE_LLM_PROVIDER`, `WHATSAPP_TEMPLATES_DRY_RUN`, `STRESS_API_KEY`, `LOAD_API_KEY`, `NODE_ENV` (o Next define), `NEXT_TELEMETRY_DISABLED` (CI). O gate de `src/instrumentation.ts` já aborta o boot se usadas contra Meta real/Supabase de produção — manter.

### 6.2 Chaves e credenciais de cliente → cofre `provider_key`

**Decisão:** estender o cofre (175) em vez de criar tabela nova (reaproveita RLS fechada, cifra, `last4`, trigger de auditoria, API e tela). Mudança mínima:
- `kind IN ('variable','credential','provider_key')`; `provider_key`: valor cifrado, **`allowed_hosts` nulo** (a chave é usada pelo servidor, não injetada em tool), nome em catálogo fechado (lista abaixo), **fora** do `loadAccountSecrets` das tools (`account-secrets.ts:61` ignora o tipo) → um fluxo/agente **nunca** consegue ler ou enviar uma `provider_key` com `{{cred.X}}`.
- Catálogo (nomes reservados): `LLM_OPENAI_API_KEY`, `LLM_ANTHROPIC_API_KEY`, `LLM_GEMINI_API_KEY`, `LLM_OPENROUTER_API_KEY`, `DDM_TOKEN` (já existe como `credential` com host `ddmacordos.com`; **continua `credential`** — é também usada por `{{secret.DDM_TOKEN}}` nas tools), `UTM_API_KEY`, e (opção BYO, 6.5) `META_APP_SECRET`/`META_APP_ID`/`INSTAGRAM_APP_SECRET`.
- `ai_config` mantém `api_provider`/`api_model`/`elevenlabs_api_key` (não muda) e a coluna `api_key` fica como **legado lido por último** até o prazo (6.4); um script `scripts/migrate-ai-keys-to-vault.mjs` (dry-run por padrão, `--apply`, sem env nova) copia `ai_config.api_key` → `provider_key` do provedor da conta, com CAS e relatório (padrão `encrypt-plaintext-ai-keys.mjs` da entrega R-1/R-2).
- **Resolvedor único** `lib/ai/llm-key.ts`:
  ```
  resolveLlmKey(db, accountId, purpose) →
    1. cofre provider_key do provedor efetivo da conta   (purpose: text|stt|dispatch|intelligence)
    2. ai_config.api_key (legado, enquanto existir)
    3. chave da plataforma (env) SOMENTE se platform_config 'ai.platform_key_fallback' = true
    4. erro explícito (missing_provider_api_key) — nunca ciphertext como chave (PRD 14 SG-6)
  ```
  Substitui os 6 pontos divergentes (`responder.ts:900-924`, `:932`, `llm-shared.ts:53-65`, `intelligence/chat/route.ts:64`, `simulator/ai.ts:256-261`, `dispatch-ai.ts:36`); o simulador passa a usar o **mesmo** ternário do responder (hoje cai em Gemini para qualquer provedor desconhecido).
- **"IA da casa" (fallback da plataforma):** duas opções técnicas — **(i) sem fallback** (recomendada): cada conta traz a própria chave; a DDM cadastra as chaves hoje no `.env` na **própria conta DDM**; **(ii) com fallback**: o env da plataforma continua, ligado por `ai.platform_key_fallback` (e `INTELLIGENCE_DAILY_MAX_MESSAGES` vira o controle de custo). Conta sem chave e sem fallback fica sem IA (é o `failed` atual). **Decisão comercial → pergunta 13.2.**
- `dispatch-ai.ts`: recebe `accountId`; o cliente OpenAI passa de "variável de módulo por chave" para mapa `accountId→client` com TTL 60 s (cache **por tick/TTL**, não por processo eterno: a regra "cache por chamada" de `account-secrets.ts` não serve a um laço por item).
- `DISPARADOR_OPENAI_API_KEY` **sai**: a chave da conta já separa o custo.

### 6.3 Parâmetros de plataforma → `platform_config`

**Tabela e leitura** (padrão proposto pela revisão de AJUSTE/FLAG, alinhado ao cache já aceito no projeto):
- `wacrm.platform_config(key text pk, value jsonb, version int, updated_at, updated_by, note)` + `platform_config_history` + `platform_admins(user_id)`; RLS ligada sem policy, `REVOKE ALL` de clientes; escrita só por RPC `set_platform_config(key, value, reason)` (valida pelo **registro em código** `lib/platform-config/registry.ts`: chave, tipo, min, max, padrão, `readAt: tick|request`, `sensitive:false`), gravando histórico na mesma transação.
- `getPlatformConfig()` devolve snapshot `{values, loadedAt}`: 1 query (`select key, value`, dezenas de linhas) por processo a cada **TTL 15–30 s**, dedupe de leituras simultâneas (modelo `monitor-snapshot.ts:698-709`). O tick/rota carrega o snapshot **uma vez** no início e passa o objeto adiante; caminhos quentes (`llm-gate.ts`, `getMetaTimeoutMs()`) usam `getPlatformConfigSync()` (último snapshot ou padrão do registro) — sem I/O por chamada.
- Falha de leitura/tabela ausente: **stale-while-error** (último snapshot) → env → padrão do registro; aviso com limite de frequência; nunca derruba o tick.
- Precedência na convivência: **`banco (se a chave existe) > env (se definido) > padrão`**; `source` por valor exposto no relatório e no `cron_tick` (versão ativa). Sem broadcast: gravação invalida o processo local, os outros vencem por TTL (≤ 30 s).
- **Segredos nunca entram aqui** (cofre cifrado); `ENCRYPTION_KEY` fica no `.env`.

**Destino de cada parâmetro (AJUSTE/FLAG) — padrões e clamps atuais mantidos:**

| Variável | Quando é lida | Destino | Fallback env→banco / prazo | Leitores que mudam |
|---|---|---|---|---|
| `DISPATCH_PROCESS_CONCURRENCY` (4; 1..150) | tick | **platform_config** `disparador.process_concurrency` | banco > env > 4; remover env D+30 | `throughput-config.ts:83-113`, `concurrency.ts:56`, `cron/route.ts:315` |
| `DISPARADOR_TICK_BUDGET_MS` (35 000/50 000; 5 000..50 000) | tick | **platform_config** `disparador.tick_budget_ms`, com guarda (>40 000 só com chain ligado) | idem | `throughput-config.ts:108`, `limits.ts:331` |
| `DISPARADOR_AUTO_PAUSE` + `_WINDOW`(100) `_MIN_ATTEMPTS`(50) `_ERROR_RATE`(0,30) `_UNCERTAIN_COUNT`(20) `_UNCERTAIN_WINDOW_SECONDS`(60) | tick | **platform_config** `disparador.auto_pause.*`; piso da plataforma; (futuro) override por conta **só mais rígido**; `enabled` só pelo operador, com motivo | idem | `auto-pause.ts:58-74`, `cron/route.ts:338` |
| `AI_LLM_MAX_CONCURRENCY`(20) `_QUEUE_MAX_WAIT_MS`(60 000) `_429_MAX_RETRIES`(2) `_429_MAX_WAIT_MS`(8 000) | por chamada (hot path) | **platform_config** `ai.llm.*` (valor por processo; semáforo continua em memória) | idem; snapshot **síncrono** | `llm-gate.ts:20-40,91,96,143,169` |
| `AI_STALL_SECONDS`(180) `AI_STALL_MAX_MINUTES`(30) | tick de flows | **platform_config** `ai.stall.*` (**mesmos padrões; valor = Decisão da operação, 4.1**) | idem | `ai-watchdog.ts:34-48` |
| `META_TIMEOUT_MS`(30 000; ≤120 000) `WAHA_TIMEOUT_MS`(15 000; ≤120 000) | por chamada | **platform_config** `providers.meta_timeout_ms`, `providers.waha_timeout_ms` ("botão de incidente") | idem; snapshot síncrono | `meta-api.ts:22-32`, `waha-api.ts:51-58` |
| `AI_EXTERNAL_RAG_ENABLED` (desligado) | por turno | **platform_config** `ai.external_rag.enabled` como **kill switch** (padrão desligado; travas por conta já existem: perfil + credencial com `allowed_hosts`) | idem; remover env D+30 | `external-rag.ts:18-20,32`, `responder.ts:1161` |
| `INTELLIGENCE_MODEL`(`gpt-4o-mini`) `INTELLIGENCE_DAILY_MAX_MESSAGES`(200) | requisição | **por conta** (`account_settings`) com **padrão e teto da plataforma** | conta > plataforma > padrão; remover env D+30 | `openai-client.ts:15`, `chat/route.ts:102,129`, `store.ts:20`, `chats/route.ts:17` |
| `LEAD_EXTRACTOR_URL` | requisição | **por conta** (`account_settings`; vazio = oculto) | conta > env > vazio; remover env e o padrão da DDM D+30 | `external-urls/route.ts:6`, `lead-extractor/page.tsx:11` |
| `DISPARADOR_PER_NUMBER_CONCURRENCY` / `_META` / `_WAHA` | tick | **constante 4** (padrão do número sem linha); o ajuste fino já é **por número em tela**; teto WAHA 50 constante | remover env após o live confirmar que todo número habilitado tem linha em `dispatch_channel_limits` (13.2-7) | `throughput-config.ts:85-101`, `limits.ts:327-337,421` |
| `DISPARADOR_ADAPTIVE_BACKOFF`, `_MAX_EVENT_LOOP_LAG_MS`(200), `_BACKOFF_COOLDOWN_SECONDS`(300), `_ASSUMED_P95_S`(1), `_131026_CONFIRM_MINUTES`(1440), `_PREPARE_BUDGET_MS`(240 000; teto 270 000), `DISPATCH_OPENAI_TIMEOUT_MS`(30 000), `_TICK_CHAIN_MAX_PER_MIN`(6) `_MAX_HOPS`(90) `_MAINTENANCE_EVERY`(5) | tick/req | **constante no código** (mesmos valores) | remover env no próximo release | `throughput-config.ts:102-112`, `cron/route.ts:81-84,220`, `prepare/cron:30`, `dispatch-ai.ts:10`, `tick-chain.ts:61-63` |
| `AI_KB_MAX_CHARS` | req (ramo legado) | **REMOVER** (perfil já define 40 000) | quando não houver agente sem `agentRuntime` (13.2-8) | `kb-context.ts:19`, `convert.ts:117` |
| `META_GRAPH_VERSION`(v25.0, **lida no import**) e `META_API_VERSION` (inexistente) | import | **constantes** `lib/meta/versions.ts` (WhatsApp v21.0; sociais v25.0) com data de validação | remover env | `graph.ts:14`, `meta-api.ts:15`, `templates/sync:26` |
| `DISPARADOR_MAX_RSS_MB`(1024) | tick | **continua no `.env`** (propriedade do host) | — | — |

### 6.4 Flags de implantação: critério de remoção (temporárias)

| Flag | Padrão | Remover quando | Depois |
|---|---|---|---|
| `DISPARADOR_TICK_CHAIN` | desligada | proxy com timeout ≥ 60 s confirmado + 1 semana de `cron_tick` sem estourar orçamento | vira padrão ligado; env some |
| `DISPARADOR_BATCH_CLAIM` | desligada | validada em Postgres real na bancada #132 e migration 188 aplicada | vira padrão ligado |
| `DISPARADOR_PREPARE_IN_TICK` | ligada | agendador externo chamando `/api/disparador/prepare/cron` | ramo no tick apagado |
| `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET` | desligada | todas as sessões WAHA reiniciadas com `?channel=` | ramo legado apagado (PRD 14 SW-4) |
| `WEBHOOK_MESSAGE_INBOX` (PRD 15) | `off` | `shadow` sem divergência por 3–7 dias | vira padrão `on` |

Cada flag ganha um **prazo na própria tabela do `docs/env.md`** e entra no relatório `env-report` com o aviso "vencida" quando passa do critério.

### 6.5 App Meta (META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, INSTAGRAM_*)

**Hoje:** o WhatsApp **já valida o HMAC por canal** (acha o canal por `phone_number_id`/`waba:<id>` do corpo, `webhook/route.ts:249-282,398-491`; `app_secret` do canal obrigatório no 1º save `config/route.ts:722`; `META_APP_SECRET` é só fallback e rede para texto puro legado `:464-477`) — isso é, na prática, o modelo "app por cliente". O **handshake GET** varre todos os `whatsapp_config` e compara o `verify_token` (`:149-179`, com os problemas SW-3 do PRD 14). **Instagram/Messenger** usam **um app da plataforma** (segredo global, `meta/webhook/route.ts:49-50`; roteamento por `channels.external_id`, `ingest.ts:24-27`). OAuth social e **upload de header de template** usam o app da plataforma via env (`oauth.ts:103-186`, `template-header-handle.ts:30`). Não há Embedded Signup, `debug_token`, `appsecret_proof` nem System User no código (o cliente cola o token à mão).

| Critério | **A** app da PLATAFORMA (Embedded Signup) | **B** app POR CLIENTE | **C** híbrido (A padrão, B opcional) |
|---|---|---|---|
| Quem cria/revisa o app | DDM (um app; precisa ser **Tech Provider/BSP**, verificação de negócio e App Review das permissões de WhatsApp/Instagram/Messenger) | cada cliente cria app, produto WhatsApp, webhook e cola 3–4 valores | DDM + clientes que preferem app próprio |
| HMAC `x-hub-signature-256` (é **por app**) | um segredo (`META_APP_SECRET`) no `.env`; canais **managed** sem `app_secret` | por canal (já existe); social precisa de coluna/roteamento análogos | segredo do canal se houver, senão o da plataforma **só para canal `managed`** (nunca o inverso) |
| Handshake GET | um `META_WEBHOOK_VERIFY_TOKEN` e uma URL | cada app tem o seu; o GET não traz canal → varre-todos (escala mal) ou **URL por canal `?channel=<uuid>`** como o WAHA (`waha-webhook-auth.ts:41-59`) | token global + `?channel=` para BYO |
| Roteamento do segredo certo | desnecessário p/ segurança (1 app); conta por `phone_number_id`/`entry.id` | corpo→canal (já feito no WhatsApp); IG/Messenger **hoje seriam inseguros** (um cliente com app próprio assinaria com o próprio segredo e injetaria em página de outra conta) → replicar o desenho do WhatsApp; **nunca "tentar todos os segredos"** (O(n) HMAC por POST = vetor de DoS) | corpo + URL por canal p/ BYO |
| Limites | todos dividem o teto da Graph por app/WABA; throttling de um afeta app-level | isolamento natural | enterprise isolado |
| Risco de concentração | **ALTO**: app suspenso/revisão cassada derruba todos; vazamento do `app_secret` forja webhook de qualquer cliente | baixo | médio |
| Migração dos canais atuais | **re-subscrever** cada WABA ao app da plataforma e trocar webhook, com janela de dupla validação (já existe o padrão `:464-477`) | zero no WhatsApp; IG/Messenger: coluna de secret por canal + backfill do global | zero: atuais seguem BYO; novos entram em A |
| Self-service | melhor UX ("Conectar WhatsApp") | pior UX, melhor isolamento | melhor equilíbrio |
| Custo p/ a DDM | **alto** (Tech Provider, suporte, conformidade) | alto atrito/suporte por cliente | soma dos dois |

**Recomendação: opção C, em duas fases.**
- **Fase 1 (sem decisão Meta, barata):** manter o que existe (WhatsApp por canal) e declarar `META_APP_ID/SECRET`, `INSTAGRAM_*`, `META_WEBHOOK_VERIFY_TOKEN` como **"app da plataforma"** no `.env` (infra), usado só para Instagram/Messenger e fallback. Em paralelo: (a) **`META_APP_ID` para upload de header de template** deixa de ser global — descobrir o `app_id` do canal via `GET /debug_token` do `access_token` do canal (ou coluna `whatsapp_config.app_id`), porque o *resumable upload* é **escopado ao app dono do token** e o app global dá erro no modelo BYO; (b) **segredo por canal social** (coluna cifrada em `channels`) e **roteamento por canal** em `/api/meta/webhook` (cópia do desenho do WhatsApp), antes de aceitar qualquer app de cliente; (c) `INSTAGRAM_APP_SECRET ?? META_APP_SECRET` vira segredo **por app**, sem fallback cruzado (ENV-14); (d) handshake por URL de canal (`?channel=`) como alvo, mantendo o token global durante a convivência.
- **Fase 2 (depende do dono):** se a DDM virar Tech Provider, **Embedded Signup** como padrão (canais `managed`: `app_secret` nulo, HMAC pelo segredo da plataforma só para esses; troca do `code` por token usa `META_APP_SECRET`), mantendo BYO opcional. Código: aceitar `app_secret` nulo em `managed` (`config/route.ts:722` hoje exige), coluna `managed boolean`.
- **Por que não A puro:** concentra risco, exige App Review fora do controle da DDM e quebra os canais atuais que assinam com app próprio. **Por que não B puro:** contradiz o self-service (o cliente cria app Meta e cola 4 valores). **Decisão → pergunta 13.1.**

### 6.6 Outras variáveis "de cliente" reclassificadas

| Variável | Destino | Quem edita | Leitores que mudam | Prazo |
|---|---|---|---|---|
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `CLAUDE_API_KEY`≡`ANTHROPIC_API_KEY` (**um nome só**), `OPENROUTER_API_KEY` | cofre `provider_key` por conta (6.2); env só se `ai.platform_key_fallback` | owner/admin | os 6 pontos do resolvedor | env removido D+30 do release da tela e do script de migração |
| `DISPARADOR_OPENAI_API_KEY` | **remover** (chave da conta) | — | `dispatch-ai.ts:36` | com a 19.4 |
| `DDM_ACORDOS_API_TOKEN`; `DDM_TOKEN`, `DDM_API_KEY` | cofre `DDM_TOKEN` (credencial, host `ddmacordos.com`); **aliases removidos**; o **nome** `DDM_TOKEN` do marcador permanece | owner/admin | `responder.ts:104,1365`, `tool-secrets.ts:35`, `agents/service.ts:154`, `convert.ts:142`, `schema.ts:48` (nomes em `platform_env`) | D+30; confirmar no live qual nome o servidor usa (13.2-5) |
| `UTM_API_KEY` | cofre `provider_key` `UTM_API_KEY` por conta; host `utmpay.grupoddm.ia.br` continua constante (override futuro por `account_settings`) | owner/admin | `utm/route.ts:25`, `utm/metricas/route.ts:48`; mensagem do wizard (`campaign-wizard.tsx:545`) aponta a tela | D+30 |
| `WAHA_WEBHOOK_SECRET` | **fica no `.env` (INFRA)**: é o mestre do HMAC por canal; cliente/WAHA nunca o veem (`waha-webhook-auth.ts:30-35`); rotacionar = reiniciar sessões | operação | — | — (opcional futuro: `webhook_secret` aleatório por canal em `whatsapp_config`, eliminando o mestre) |
| `STRESS_API_KEY`, `LOAD_API_KEY` | fora do `.env`; a rota de stress cria/acha a chave da conta de teste (PRD 15) | — | `stress/run/route.ts:329-358` | com o PR de stress |
| `DDM_LOGS_USER/PASSWORD`, `DISPATCH_SINGLE_ACCOUNT_ID`, `DISPARADOR_URL`, `SUPABASE_URL` | **remover** | — | exemplo/docs | imediato |
| `LEAD_EXTRACTOR_URL` | por conta (6.3) | owner/admin | `external-urls`, `lead-extractor/page.tsx` | D+30 |
| `NEXT_PUBLIC_SITE_URL`, `ALLOWED_INVITE_HOSTS` | consolidar em `NEXT_PUBLIC_APP_URL`; convite falha fechado sem ela | operação | `invitations/route.ts:77,95`, `waha-webhook-auth.ts:46` | imediato (`NEXT_PUBLIC_*` é embutida no **build**: precisa estar no ambiente de build) |
| `SSRF_ALLOWED_HOSTS` | **fica no `.env`** (segurança da plataforma; cliente nunca libera rede interna). Auditar o valor em produção (PRD 14 §6.7) | operação | — | — |
| `VOIP_URL`, `VOIP_SERVICE_SECRET` | fica (INFRA do serviço Go) | operação | — | — |

### 6.7 Padrão de migração env → banco (sem downtime)

1. Deploy do código com **leitura dupla** (banco > env > padrão) — o banco ainda vazio, comportamento igual.
2. Script `scripts/migrate-env-to-config.mjs` (dry-run por padrão, `--apply`; **não cria env nova**): lê o ambiente **do servidor onde roda**, grava as chaves em `platform_config` e copia as chaves de LLM/DDM/UTM do env para o cofre da **conta DDM** (nome da conta pedido por argumento), imprimindo **só nomes e contagens**, nunca valores.
3. Operador confere a tela/`env-report` (`source:'db'`), remove a variável do `.env` do servidor e reinicia (`touch tmp/restart.txt`).
4. Após **D+30** sem leituras `source:'env'` no relatório, **PR de remoção** da leitura de env e da linha do `.env.*.example`.
5. Rollback: restaurar a variável no `.env` e reiniciar (a precedência ainda cai nela enquanto o código de fallback existir); depois do PR de remoção, restaurar = reverter o PR + variável.

## 7. Dados e migrations (faixa 230–239)

Todas manuais, idempotentes, com **PRÉ-CHECK vivo** que aborta sem alterar (padrão 192), `CONCURRENTLY` sozinho se houver índice grande. Conferir o schema vivo antes (regra do projeto).

| Nº | O que faz | Ordem vs deploy | CONC. | Rollback |
|---|---|---|---|---|
| 230 | `platform_config`, `platform_config_history`, `platform_admins`, RPC `set_platform_config(key, value, reason)` (SECURITY DEFINER, `search_path` vazio, valida operador e grava histórico na mesma transação), RLS fechada | ANTES do deploy (código cai no env sem ela) | não | `DROP` das funções/tabelas |
| 231 | `account_settings(account_id, key, value jsonb, updated_by, updated_at)` + trigger de auditoria genérico; `PRIMARY KEY (account_id, key)`; RLS fechada (leitura/escrita só por rota) | antes | não | `DROP TABLE` |
| 232 | `account_secrets`: CHECK de `kind` aceita `'provider_key'`; `allowed_hosts` opcional **só** para `provider_key`; nomes reservados; índice por `(account_id, kind)`; trigger de auditoria já existe | antes | não | reverter CHECK (sem linhas `provider_key`) |
| 233 | `platform_audit_logs` (ator, ação, chave, antes, depois, motivo, `created_at`), RLS fechada | antes | não | `DROP TABLE` |
| 234 | `whatsapp_config.app_id text`, `whatsapp_config.managed boolean default false` (fase 2), coluna cifrada de segredo por canal social em `channels` (`app_secret`) | antes ou depois | não | `DROP COLUMN` |
| 235 | RPC `platform_env_report()` (opcional): só nomes/contagens | antes ou depois | não | `DROP FUNCTION` |
| 236–239 | reservadas (backfills em lote, índices CONCURRENTLY) | — | — | — |

**Pré-checks (rodar antes e guardar):**
```sql
SELECT to_regclass('wacrm.platform_config'), to_regclass('wacrm.account_settings'), to_regclass('wacrm.platform_audit_logs');   -- NULL antes
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid='wacrm.account_secrets'::regclass AND contype='c';        -- CHECK atual de kind/shape (232)
SELECT column_name FROM information_schema.columns
 WHERE table_schema='wacrm' AND table_name IN ('whatsapp_config','channels') ORDER BY 1;   -- 234
SELECT to_regprocedure('wacrm.audit_generic_changes()');                  -- trigger genérico da 131 (231/232)
```
Backfills de valores (env→banco) são **script**, não migration (precisam do ambiente do servidor).

## 8. Contrato para o frontend

> Front é de outra pessoa; só consome. Toda rota nova: `Cache-Control: no-store`, `request_id` no erro, segredo **nunca** devolvido (só `last4`, `configured`, `source`).

| Rota | Método | Papel | Resposta / payload | Erros | Tela |
|---|---|---|---|---|---|
| `/api/settings/integrations` | GET | supervisor+ (lista mascarada) | `{integrations:[{provider:'llm_openai'\|'llm_anthropic'\|'llm_gemini'\|'llm_openrouter'\|'ddm_acordos'\|'utm'\|'meta_app', label, configured:bool, last4, source:'account'\|'platform'\|'none', updated_at, updated_by}], platformKeyFallback:bool}` | 401/403 | "Integrações" (cards por provedor) |
| `/api/settings/integrations/{provider}` | PUT | owner/admin | `{value, reason?}` → cifra no servidor; `{configured:true,last4}` | 400 formato; 403 papel; 409 conflito | formulário write-only (campo vazio ao reabrir) |
| `/api/settings/integrations/{provider}` | DELETE | owner/admin | `{configured:false}` | 404 | botão "Remover" |
| `/api/settings/integrations/{provider}/test` | POST | owner/admin | chamada mínima ao provedor (host fixo; SSRF-guard) → `{ok:bool, message}` (nunca eco do segredo) | 422 provedor recusou; 429 | "Testar conexão" |
| `/api/settings/account-config` | GET | supervisor+ | `{settings:[{key, label, type, value, source:'account'\|'platform'\|'default', default, min, max, editable:bool}]}` (modelo e teto do Intelligence, link do extrator de leads) | — | "Configurações da conta" |
| `/api/settings/account-config/{key}` | PUT | owner/admin | `{value, reason?}` valida contra o registro e o teto da plataforma | 422 `above_platform_cap`; 400 | idem |
| `/api/platform/config` | GET | **operador da plataforma** | `{config:[{key, label, type, value, source:'db'\|'env'\|'default', default, min, max, readAt, version, updatedAt, updatedBy}]}` | 403 | "Plataforma → Parâmetros" |
| `/api/platform/config/{key}` | PUT | operador da plataforma | `{value, reason}` (**motivo obrigatório**, ≥ 5 caracteres) → grava com histórico | 422 faixa; 409 versão (`expected_version`) | idem, com diff "antes → depois" |
| `/api/platform/config/history` | GET | operador | keyset 50/página: `{items:[{key, before, after, reason, by, at}]}` | — | histórico |
| `/api/platform/env-report` | GET | operador | `{variables:[{name, class:'essential'\|'temporary_flag'\|'moved'\|'removed', readFromEnv:bool, source, deadline?}], expiredFlags:[…]}` — **só nomes e origem**, nunca valores | — | painel "Higiene do .env" |

Papéis: owner/admin escrevem integrações e `account-config`; supervisor+ lê mascarado; **operador da plataforma** é papel novo (tabela `platform_admins`), não derivado de owner/admin de conta. Mensagens de erro em pt-BR. O front **deve** tratar "campo write-only": nunca pré-preencher segredo.

## 9. Testes e aceite

| Camada | O que prova | Onde |
|---|---|---|
| Unit | snapshot (TTL, dedupe, stale-while-error, precedência db>env>default); `resolveLlmKey` por propósito/provedor/fallback; `ddmApiToken`; registro (faixa, clamp); catálogo de `provider_key` fora das tools | vitest, relógio injetável |
| PGlite | migrations 230–235 idempotentes; RPC `set_platform_config` (histórico na mesma transação; só operador); CHECK de `kind`; grants (`anon`/`authenticated` sem acesso); pré-check que **aborta** | `*.sql.test.ts` (timeout 60 s, PRD 15 P-08) |
| Rotas | papel × conta × teto; segredo mascarado; `test` sem eco; operador × owner de conta | vitest (padrão `role-gate.test.ts`) |
| Regressão | testes existentes de `throughput-config`, `auto-pause`, `llm-gate`, `waha-webhook-auth`, `ssrf-guard`, `convert` com a nova fonte | vitest |
| Staging | migração env→banco com tráfego de teste; `env-report` sem leituras de env após remover as variáveis | Supabase de desenvolvimento |
| CI | grep: nenhuma leitura de `process.env.<NOME>` nas variáveis removidas; construtor `OpenAI` sem `baseURL` falha lint | `.github/workflows/ci.yml` |

**"Pronto" =** (a) `.env.production.example` com só os nomes da 6.1; (b) conta nova usa IA, DDM e UTM sem tocar no servidor; (c) `env-report` mostra 0 leituras de env para as variáveis migradas por 30 dias; (d) mudar timeout/concorrência pela tela vale em ≤ 30 s com auditoria; (e) nenhuma `provider_key` acessível por `{{cred.X}}`.

## 10. Observabilidade

| Sinal | Fonte | Limiar | Gravidade | Canal |
|---|---|---|---|---|
| Variável **ainda lida do env** depois do prazo | `env-report` / log de boot (nomes) | `deadline` vencido | média | alerta semanal ao operador |
| Flag temporária vencida | `env-report` | critério de remoção cumprido e flag ainda definida | baixa | idem |
| Falha de leitura de `platform_config` | snapshot | > 3 falhas/min (usando último snapshot) | média | `writeLog` (limitado) |
| Mudança de `platform_config`/`provider_key` | `platform_audit_logs`/`audit_logs` | cada uma | info | tela de auditoria |
| `resolveLlmKey` caiu na chave da plataforma | contador por conta | qualquer, se `platform_key_fallback` ligado | info (custo) | métrica |
| `cron_tick` | versão de `platform_config` ativa | — | info | Monitor |
| Chave de cliente inválida (401 do provedor) | `integrations/test` e uso real | recorrente | média | aviso na tela de Integrações |

## 11. Riscos, rollback e plano de implantação

| Risco | Mitigação |
|---|---|
| Tirar a chave de LLM do env deixa contas sem IA | só remover após a migração `--apply` na conta DDM e o `env-report` zerado; `ai.platform_key_fallback` como válvula (opção 6.2-ii); rollback = recolocar a variável |
| Snapshot desatualizado em incidente | TTL ≤ 30 s e `invalidate` local; parâmetro de incidente (timeouts) tem `readAt` explícito |
| Banco indisponível derruba parâmetros | stale-while-error → env → padrão; nunca derruba o tick |
| `provider_key` vazar por tool/fluxo | tipo separado, ignorado por `loadAccountSecrets`, teste que prova `{{cred}}` → "ausente"; nomes reservados |
| Operador da plataforma mal definido | papel explícito (`platform_admins`), motivo obrigatório, histórico imutável; pergunta 13.4 |
| Mudar versão da Graph (21→25) altera envio | **não mexer** sem validação (constante por superfície, data anotada); pergunta 13.9 |
| Remover env cedo demais | prazo D+30 com relatório; PR de remoção separado |
| `NEXT_PUBLIC_*` no build | `deploy.sh` (PRD 15) exige no ambiente de build |
| Hash dos perfis de agente muda | `convert.ts` grava padrões do schema, não o env (ENV-12); script só reexecutado sob demanda |

**Ordem de implantação:** 1) limpeza sem migration (19.1) → 2) 230/233 + `platform_config` + migrar AJUSTE (19.2) → 3) 231 + por conta (19.3) → 4) 232 + resolvedor + chaves (19.4) → 5) DDM/UTM (19.5/19.6) → 6) Meta fase 1 (19.7) → 7) remoção dos fallbacks (19.9) → 8) Meta fase 2 se o dono decidir (19.8).

## 12. Fases e PRs

Tamanho: P ≤ 1 dia, M 2–4, G > 4. **Todos com base `v2`**, sem empilhar (cada um parte de `origin/v2`). BE = backend, OPS = infraestrutura/dono do servidor.

| # | PR | Conteúdo | Dep. | Dono | Tam. |
|---|---|---|---|---|---|
| 19.1 | `env-limpeza` | `.env.production.example` mínimo + exemplos; remover do exemplo/docs `DDM_LOGS_*`, `DISPATCH_SINGLE_ACCOUNT_ID`, `DISPARADOR_URL`, `SUPABASE_URL`; unificar `NEXT_PUBLIC_SITE_URL`→`APP_URL` (convite falha fechado); `OpenAI` com `baseURL` explícito (ENV-04); `WHATSAPP_TEMPLATES_DRY_RUN` ignorada em produção (ENV-05); constantes (`lib/meta/versions.ts`, per-number/backoff/chain/etc.) sem env; corrigir docs (`DISPATCH_PROCESS_CONCURRENCY` 1..150); `docs/env.md` | PRD 15 §15.1 | BE | M |
| 19.2 | `platform-config` | migrations 230/233; registro; snapshot; RPC; rotas `/api/platform/*`; papel operador; migrar `DISPATCH_PROCESS_CONCURRENCY`, `TICK_BUDGET`, `AUTO_PAUSE*`, `AI_LLM_*`, `AI_STALL_*`, `META/WAHA_TIMEOUT`, `AI_EXTERNAL_RAG`; `env-report`; `convert.ts` sem congelar env | 19.1 | BE | G |
| 19.3 | `config-por-conta` | migration 231; `account_settings`; `INTELLIGENCE_*` e link do extrator por conta; rotas `/api/settings/account-config*` | 19.2 | BE | M |
| 19.4 | `chaves-llm-cofre` | migration 232; `provider_key`; `resolveLlmKey` único (6 pontos, simulador igual ao responder); Whisper e disparador IA por conta; chat de inteligência conta-primeiro; `scripts/migrate-ai-keys-to-vault.mjs`; `scripts/migrate-env-to-config.mjs`; rotas `/api/settings/integrations*` | 19.2, PRD 14 §14.4/14.13 | BE | G |
| 19.5 | `ddm-token-conta` | `ddmApiToken(accountId)` via cofre; remover aliases `DDM_TOKEN`/`DDM_API_KEY` de env e de `platform_env` | 19.4 | BE | P |
| 19.6 | `utm-por-conta` | `UTM_API_KEY` por conta; mensagem do wizard aponta a tela | 19.4 | BE | P |
| 19.7 | `meta-fase1` | migration 234; `app_id` por canal (via `debug_token`); upload de header com o app do canal; segredo por canal social + roteamento por canal em `/api/meta/webhook`; segredo por app sem fallback cruzado; handshake `?channel=`; documentar "app da plataforma" | 19.1, PRD 14 (SW-3) | BE | G |
| 19.8 | `meta-fase2-embedded-signup` | **condicional à decisão do dono (13.1)**: Embedded Signup, canais `managed`, troca de `code` por token, re-subscribe do WABA | 19.7 | BE+OPS | G |
| 19.9 | `env-remocao-fallbacks` | após D+30: apagar leituras de env migradas, linhas do exemplo, alias de `platform_env`; lint contra reintrodução | 19.2–19.6 | BE | M |
| 19.10 | `flags-ciclo-de-vida` | tabela de flags com critério/prazo + alerta de flag vencida; remover flags cujo critério foi cumprido | PRD 11/15 | BE | P |

## 13. Perguntas ao dono e itens "A confirmar no live"

### 13.1 Perguntas ao dono (decisão)

1. **App Meta (decisão central):** recomendo a **opção C** — Fase 1 (barata): WhatsApp segue por canal (cada cliente com `app_secret` próprio, como hoje) e o `.env` guarda só o **app da plataforma** para Instagram/Messenger e fallback; Fase 2: **Embedded Signup** como padrão, com app próprio opcional. **A DDM quer e pode se credenciar como Tech Provider/BSP da Meta** (verificação de negócio e App Review das permissões de WhatsApp, Instagram e Messenger), aceitando que um app único vira **ponto único de falha** para os clientes "gerenciados"? Se **não**, a resposta é B (cada cliente cria o app) e o `.env` mantém só o app da plataforma para Instagram/Messenger.
2. **IA da casa:** a DDM oferece chave de LLM da plataforma como fallback para clientes (opção ii, com controle de custo pelo teto diário) ou **cada conta traz a própria chave** (opção i, recomendada)? Isso decide se `OPENAI_API_KEY` & cia. saem 100% do `.env`.
3. **DDM Acordos é integração do cliente ou só da DDM?** Se só da DDM, basta um cadastro no cofre da conta DDM e o env sai; se de clientes, vira cartão em "Integrações" para qualquer conta.
4. **Operador da plataforma:** quem edita `platform_config` (hoje não existe papel)? Proponho tabela `platform_admins` mantida pela DDM (por exemplo, 1–2 pessoas), com motivo obrigatório e histórico. Pode ser você + o time técnico?
5. **Nome do token DDM em produção:** o servidor usa `DDM_ACORDOS_API_TOKEN`, `DDM_TOKEN` ou `DDM_API_KEY`? (define o alias a remover e o conteúdo do script de migração)
6. **Segredos de cron:** unificar `CRON_SECRET` e `AUTOMATION_CRON_SECRET` num só (menos um segredo no `.env`)? Isso muda o crontab do servidor (PRD 15).
7. **Prazo de convivência env→banco:** aceita **30 dias** por variável (precedência `banco > env > padrão`, relatório de higiene, depois PR de remoção)?
8. **Auto-pausa:** confirma que os limiares ficam como **piso da plataforma** (configuráveis só pelo operador) e que, no futuro, a conta só poderá torná-los **mais rígidos**? (valores = decisão da operação)
9. **Versões da Graph API:** o envio do WhatsApp usa **v21.0** e os canais sociais **v25.0**. Mantemos assim (constante por superfície) ou quem mantém o envio Meta valida a subida da v21.0? (não mexo sem validação)
10. **`LEAD_EXTRACTOR_URL`:** link por conta (vazio = item de menu oculto) ou removemos o item de menu da plataforma?
11. **`WAHA_WEBHOOK_SECRET`:** concorda em classificá-lo como INFRA (fica no `.env`, é o mestre do HMAC por canal) em vez de mover para o cofre por conta?
12. **Teto diário do Intelligence:** quando a conta usa a **chave da plataforma**, quem define o teto (só a plataforma)? E quando usa a própria?

### 13.2 A confirmar no live

| # | O que | Como confirmar | Item |
|---|---|---|---|
| 1 | Quais variáveis estão definidas no `.env` de produção e com que valor (principalmente `DISPARADOR_AUTO_PAUSE*`, `DISPATCH_PROCESS_CONCURRENCY`, flags de tick/claim/prepare, `OPENAI_BASE_URL`, `DISPATCH_LOAD_TEST`, `WHATSAPP_TEMPLATES_DRY_RUN`) | painel do EasyPanel / `printenv` (só **nomes**) | 6.3, ENV-04/05 |
| 2 | Se `ai_config`/`whatsapp_config` têm trigger de auditoria | `SELECT tgname FROM pg_trigger WHERE tgrelid IN ('wacrm.ai_config'::regclass,'wacrm.whatsapp_config'::regclass) AND NOT tgisinternal;` | 2.1 |
| 3 | O CHECK de `account_secrets.kind` aceita novo valor? | `pg_get_constraintdef` (pré-check 232) | 232 |
| 4 | Papéis disponíveis para o "operador da plataforma" | tabela de papéis/perfis; decisão 13.1-4 | RF-03 |
| 5 | Qual nome de env o servidor usa para o token DDM | painel (só nome) | ENV-03 |
| 6 | Se o runtime V2 lê `platform_env` (declarado em schema/convert/service, sem leitor achado em `src/lib/ai`) | revisão do runtime dos agentes | ENV-11 |
| 7 | Todo número habilitado tem linha em `dispatch_channel_limits`? | `SELECT c.id FROM wacrm.whatsapp_config c LEFT JOIN wacrm.dispatch_channel_limits l ON l.session_id=c.id WHERE c.habilitado AND l.session_id IS NULL;` | per-number env |
| 8 | Existe agente em produção sem `agentRuntime` (afeta remover `AI_KB_MAX_CHARS`) | consulta aos agentes/fluxos | 6.3 |
| 9 | Número de instâncias do Passenger (`DISPATCH_PROCESS_CONCURRENCY` e `AI_LLM_MAX_CONCURRENCY` são **por processo**) | EasyPanel | 6.3 |
| 10 | Proxy com timeout ≥ 60 s para `/api/disparador/cron`; agendador externo chamando `/api/disparador/prepare/cron`; migrations 164/186/188/190/192 aplicadas | painel + queries do PRD 15 | 6.4 |
| 11 | Quantos `whatsapp_config` têm `app_secret` próprio e quantos dependem do `META_APP_SECRET` global (texto puro legado) | contagens do PRD 14 Anexo A-6 | 6.5 |
| 12 | Se o app Meta atual tem Instagram Login com app/secret próprios (diferentes do app principal) | painel da Meta | ENV-14 |
| 13 | Valor de `SSRF_ALLOWED_HOSTS` e `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET` em produção | painel (nomes/valores não sensíveis) | PRD 14 §6.7 |
