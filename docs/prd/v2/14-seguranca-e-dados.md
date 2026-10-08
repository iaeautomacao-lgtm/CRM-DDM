# 14 — Segurança e dados (V2 backend)

> Base: branch `v2` (`origin/v2` @ `4fbbbfe`, 08/10/2026), worktree `wt-codex`. Revisão **somente leitura** (nada executado: sem testes, build ou rede; **sem acesso ao banco live**). Linhas conferidas no código/migrations atuais. O que só o ambiente real responde está em **"A confirmar no live"** (consultas exatas no Anexo A). Nenhum valor de segredo foi copiado para este documento.
> Fontes: `docs/prd/09-auditoria-seguranca.md` (base antiga, migrations ≤ 166), `wt-codex-REVISAO-113.md`, `wt-codex-DISP-AUDIT.md` e cinco revisões novas por fatia (RLS/RPCs, autenticação/papéis, segredos/LGPD, SSRF/webhooks/integridade, plataforma).
> Restrições respeitadas: Meta×WAHA nunca unificados; sem worker em memória no Passenger; migrations manuais, idempotentes, com pré-check e `CONCURRENTLY` sozinho; **opt-out obrigatório** e blacklist automática do #42 **mantida**; `limite_por_hora` não muda; **retenção de dados fora do escopo**; credenciais de agente só admin/owner e write-only (decisão do V2).
> Relacionado: PRD 15 (plataforma e operação) consome as peças deste PRD (rate limit compartilhado, `schema.live`/tipos, `server-only`) e é dono do inbox de mensagens, do CI e do deploy.

## 1. Resumo

- **Problema:** a auditoria 09 (base antiga) listou 3 CRÍTICOS, 9 ALTOS, ~12 MÉDIOS. Na `v2` **os três críticos e quase todas as lacunas de papel das rotas estão corrigidos** (C-1 `profiles` migration 169; C-2/C-3 webhooks por canal; A-1 migration 170; A-2/A-5/A-8 `guardRole`; SSRF com guarda única). O que sobra é de **camada**: segredos legíveis por qualquer membro no banco (`ai_config`, `whatsapp_config`), correção do incidente do token DDM **ausente na v2**, dados pessoais em claro em logs/exports, ausência de rotação de `ENCRYPTION_KEY`, rate limit em memória, CSRF/CSP, e **nenhuma barreira contra coluna inexistente / import server→client** (incidentes #143 e #144).
- **Objetivo:** "blindado e 100%": nenhum segredo legível fora do servidor/admin; nenhuma credencial literal persistida ou logada; dados pessoais mascarados e atendimento ao titular; rotação de chave sem downtime; defesas de borda reais; e o build/CI barrando as classes de incidente já vividas.
- **Ganho:** reduz o risco de repetição do incidente do token DDM (08/10), fecha a leitura de segredos pelo navegador, torna a V2 auditável (matriz de RLS + registro do que está aplicado em cada banco) e impede regressões por tipo/CI.
- **Importante:** muita coisa depende do **estado real do banco** (as migrations "podem divergir da produção"). O Anexo A traz as consultas para o dono/DBA rodarem antes de cada migration.

## 2. Estado atual

### 2.1 Status das pendências da auditoria 09 na `v2`

| Item (09) | Status | Evidência |
|---|---|---|
| C-1 `profiles` escalada de papel/conta | **CORRIGIDO** (se a 169 estiver aplicada) | `169_profiles_lock_privileged_columns.sql:33-98` (REVOKE INSERT/UPDATE; só `UPDATE(full_name, avatar_url)`; trigger de defesa). Único UPDATE do navegador: `profile-form.tsx:142`. Live: Anexo A-1 |
| C-2 webhook Meta cross-tenant | **CORRIGIDO** | HMAC por canal e descarte de canal não validado: `whatsapp/webhook/route.ts:243-333`, `processWebhook:504-511` |
| C-3 segredo WAHA global / `X-Forwarded-Host` | **CORRIGIDO** com ressalva | HMAC por canal `waha-webhook-auth.ts:34-88`; URL do webhook por env `:41-56`. Ressalva SW-4 (flag legada) |
| A-1 tabelas sem RLS | **CORRIGIDO** (1 ressalva) | `170:37-102`; `knowledge_base_files` só se a tabela/coluna existirem (`170:108-129`) → R-3 |
| A-2 flows sem papel | **CORRIGIDO** | `lib/flows/route-auth.ts:12-31`; resíduo `flows/end-run` (AP-02) |
| A-3 SSRF http_fetch / tools / send_webhook | **CORRIGIDO** | `lib/security/ssrf-guard.ts` (`assertPublicUrl :263`, `safeFetch :385`, IP fixado no socket, redirects revalidados); `effects.ts:109-119`, `responder.ts:2211`, `automations/engine.ts:621` |
| A-4 `callback_url` / `assertWahaUrlIsSafe` | **PARCIAL** | callback ok (`processQueue.ts:1253` `safeFetch`); `wahaFetch` ainda `fetch` cru (SW-1) |
| A-5 waha start/stop/qr/pairing-code sem papel | **CORRIGIDO** | `guardRole('admin')` nas 4 rotas |
| A-6/A-7 mídia/avatar/qr | **CORRIGIDO** | `media-proxy.ts:25-75`, `avatar/route.ts:55-61`, `waha/qr/route.ts:44-49` |
| A-8 `ai-config` sem papel | **CORRIGIDO na rota; banco ainda aberto** | `ai-config/route.ts:59`; mas R-1 |
| A-9 DEFINER sem checagem | **CORRIGIDO** (4 citadas) / **PARCIAL** geral | `170:137-218`, `174:57-142`; resíduos R-4, R-5 |
| M-1/M-3/M-4/M-5/M-8/M-10/M-11 | **CORRIGIDO** | `automations/*`, `relatorios/exports:78`, `import/route.ts:153`, `queue-details:173`, templates/send/react/channel-test, `debug-db` removida, `sentiment:12` |
| M-2 referências de passos de automação | **A confirmar** (fora das fatias revisadas) | — |
| M-6 blacklist global como oráculo | **PENDENTE — decisão do dono** | `audience/blacklist/route.ts:19-35`, `blacklist-keys.ts:14-24` (SG-19) |
| M-7 SSRF cego `header_media_url`/ingest | **CORRIGIDO** | `template-header-handle.ts:41`, `ingest.ts:257` |
| M-9 UTM | **PARCIAL** | rota agora DISP + validação (`utm/route.ts:9`), métricas por conta; resíduo: `UTM_API_KEY` única e não fail-closed (SG-23) |
| M-12 escrita do navegador por papel baixo | **CORRIGIDO** | `174:145-178` |
| M-13 CSP enforce/nonce | **PENDENTE** | `next.config.ts:60,68` ainda Report-Only com `unsafe-inline/eval` (AP-04) |
| B-1 `getClientIp` forjável | **PENDENTE** | AP-07 |
| B-2/B-3/B-6/B-8/B-10/B-11/B-12/B-13/B-15 | **PENDENTE** | AP-08, AP-17, AP-16, AP-15, AP-13/SG-9/SG-10, AP-06, AP-19, AP-03, AP-01 |
| B-4/B-7/B-9/B-14 | **PARCIAL** | AP-14, AP-18, `.single()` ainda em `flows/route.ts:78,126`, `waha webhook:399`, `whatsapp/send:153` |

> **Nota sobre o inventário mecânico do Prisma (`inventario-tabelas.md`):** a coluna de RLS tem **falsos negativos** quando a migration liga RLS/REVOKE dentro de laço `DO/FOREACH` com `EXECUTE format` (ex.: 177 — `ai_agents` e cia **estão** com RLS e revoke). Neste PRD, "com/sem RLS" foi conferido **na migration** (incluindo os laços 170/177/190), e a prova final é a consulta `pg_class.relrowsecurity` + grants do **Anexo A-2/A-3**, que o dono vai rodar no banco; o resultado será incorporado.

### 2.2 Superfícies verificadas como sólidas (preservar)
Crons, `stress/run` e webhooks fail-closed com comparação em tempo constante (`matchesOperationalSecret`); HMAC por canal no WhatsApp e no WAHA; MCP/`intelligence` com escopo recalculado por requisição e resultados mascarados; cofre `account_secrets` (migration 175: RLS sem policy, `REVOKE ALL`, CHECK impede `value_plain` em credencial, `allowed_hosts` HTTPS:443); `webchat` com token sha256; chaves de API só como SHA-256; tabelas de servidor (`dispatch_*`, `webhook_status_inbox`, `ai_agents*`, `ai_tools`, `channel_health`, …) com RLS ligada e `REVOKE ALL` para clientes; `ssrf-guard` único com IP fixado no socket.

## 3. Problemas e riscos

Convenção de IDs: **R** = RLS/grants/RPCs; **AP** = autenticação/papéis/borda; **SG** = segredos/LGPD; **SW** = SSRF/webhooks; **I** = integridade de dados. Severidade conforme o modelo.

| ID | Sev. | Onde (arquivo:linha) | Problema | Cenário de falha | Correção |
|---|---|---|---|---|---|
| R-1 | **ALTA** | `031_ai_agent_config.sql:20-21` (policy `FOR ALL` só por membro); colunas `api_key`, `elevenlabs_api_key`, `system_prompt`, `enabled`; `084` é só comentário | Qualquer membro (inclusive `viewer`) **lê e escreve `wacrm.ai_config` direto pelo PostgREST**. A correção de A-8 foi só na rota. Linhas antigas guardam a chave em texto puro (`084:20-24`). | Viewer: `GET /rest/v1/ai_config?select=api_key,elevenlabs_api_key` leva a chave OpenAI/ElevenLabs da conta; `PATCH system_prompt/enabled` injeta prompt no agente que responde clientes ou desliga a IA. | Migration: `REVOKE SELECT (api_key, elevenlabs_api_key)` e `REVOKE INSERT, UPDATE` de `authenticated`; policy de leitura (`enabled`) para membro e escrita só admin; backfill que cifra as chaves legadas. A UI só lê `enabled` (`settings-overview.tsx:125-126`). |
| R-2 | **ALTA** | `153_whatsapp_config_secret_columns.sql:7-33` (restringe só INSERT/UPDATE); SELECT por `140:162-170` | A 153 fechou **escrita** de segredos, não **leitura**. Todo membro lê `access_token`, `app_secret`, `verify_token`, `waha_api_key` direto pelo PostgREST; texto puro legado é admitido na própria 153. A UI nunca pede essas colunas (selects por coluna). | Viewer: `GET /rest/v1/whatsapp_config?select=*`; onde o valor é texto puro vira segredo de assinatura do webhook (forja evento assinado) ou chave do WAHA. | `REVOKE SELECT ON wacrm.whatsapp_config FROM authenticated;` + `GRANT SELECT (colunas não secretas)`; cifrar o texto puro restante (SG-12). Verificar antes que nenhum componente usa `select('*')` (não achado). |
| SG-1 | **ALTA** | `flows/import/route.ts:125-175`; `flows/[id]/export/route.ts:54-68` | **A correção do incidente de 08/10 (commit `4d84f10`, "importação troca `tk=` por marcador e recusa credencial literal") NÃO está na `v2`** (`git merge-base --is-ancestor 4d84f10 HEAD` = não; só em `fix/ddm-token-int`/`fix/ia-ferramentas-erro-ddm-token`; há também `origin/fix/ddm-token-out-of-flows`). O import grava qualquer segredo em `flow_nodes.config`; o export da UI devolve em claro. | Fluxo exportado de outro ambiente com token literal é importado/duplicado: o token vira linha em `flow_nodes`, aparece no editor, em exports e em `flow_run_events`. **Repete o incidente.** | Levar `4d84f10` para a `v2`; ampliar: varrer **todos** os nós (`http_fetch`, `set_variable`, tools do `ai_agent`, `send_webhook`), headers/body/query; **recusar (400)** em vez de converter em silêncio; mesmo filtro no export (mascarar com `{{cred.X}}`), no duplicar e no template (`POST /api/flows`). |
| SG-2 | **ALTA** | `lib/flows/validate.ts:854-875` (`http_fetch` só confere url/método), `:1249-1269` (tools só `warning`); `ai/tool-secrets.ts:201-213` | Nó `http_fetch` **sem checagem de credencial literal** (url/headers/body); nas tools do agente é só aviso, não bloqueia ativação. | `Authorization: Bearer <literal>` no nó passa limpo e é persistido. | Aplicar `findLiteralCredential` (`ai-tools/tool-input.ts:97-117`) ao `http_fetch`; subir de warning para **erro** na ativação; ampliar nomes (`access_token`, `auth`, `password`, `pwd`, `signature`) e detectar JWT/`Bearer`/hex longo. |
| SG-3 | **ALTA** | `flows/engine.ts:3187,3196-3197,3212-3273` | `logUrl` só é mascarada quando há marcador `{{cred/var/secret}}`; URL com token literal **ou `{{cpf}}` interpolado** vai para `flow_run_events`; `redactSecrets` só roda se `credentialInjected` (`:3246`); resposta (2000 chars) e `run.vars` persistem dados de dívida/CPF. | Token literal na URL de um nó antigo aparece em claro na tela de execuções para qualquer owner/admin; CPF na query idem. | Sempre sanitizar a URL de log (remover query/mascarar params sensíveis e CPF/telefone); `redactSecrets` incondicional com os valores conhecidos. |
| SG-4 | **ALTA** | `disparador/dispatch-kick.ts:21-23,43,51-56`; `campaigns/[id]/start/route.ts:146-164` | `kickDispatchCron` monta a URL do cron a partir de `request.url` (Host da requisição) e **envia o `CRON_SECRET`** em `x-cron-secret` para ela. Os outros caminhos usam env confiável (`tick-chain.ts:64`). | Admin que faça o proxy repassar `Host: atacante.com` ao iniciar campanha faz o servidor mandar o `CRON_SECRET` (que autentica o motor de disparo) ao host dele. Depende de o proxy aceitar Host arbitrário (**confirmar**). | `originOf(DISPARADOR_CHAIN_URL ?? NEXT_PUBLIC_APP_URL)`; nunca `request.url`. |
| SG-6 | **ALTA** | `whatsapp/encryption.ts:29,37-103,152-163,182-188`; `channels/oauth.ts:69-71` | **Sem rotação de `ENCRYPTION_KEY`**: chave única, sem id/versão. Trocar torna ilegíveis todos os segredos; `tryDecrypt` (ai_config) devolve o ciphertext como se fosse a chave de API e o envia ao provedor; `account-secrets.ts:78-80` ignora credencial indecifrável em silêncio; a mesma chave assina o `state` OAuth (HMAC). | Vazamento da chave (ou backup+chave) sem como rotacionar sem derrubar WhatsApp, IA e Instagram; ou troca acidental derruba tudo. | Anel de chaves versionado + re-cifra (6.3). |
| SG-15 | **ALTA** | `flows/engine.ts:2461-2470,2490-2503` | `tool_called` grava `args` completos (CPF, valor, parcelas de `efetiva_acordo`) e `tool_result` até **8000 chars** da resposta da DDM em `flow_run_events.payload`, sem máscara. | Dados de dívida/CPF/nome de devedores replicados em log legível por owner/admin e por quem tiver acesso ao banco/MCP. | Mascarar CPF/telefone/nome (`maskPersonalText` já existe em `intelligence/mask.ts`) e guardar **resumo**, não o corpo. |
| SG-17 | **ALTA** | `055_export_history.sql:44-54,87-90` | Policy do Storage e `export_history_select` liberam leitura a **qualquer membro** (inclusive agente), enquanto gerar/listar na API exige supervisor+ (`relatorios/exports/route.ts:55`). Arquivos têm nome, telefone, agente de todos os contatos. (Confirmar se alguma migration posterior restringiu.) | Agente consulta `export_history` e baixa (signed URL) planilhas que não poderia gerar. | Restringir a policy a supervisor+ (ou ao criador); tirar `storage_path` do `get_export_history` para papéis baixos. |
| SW-1 | **ALTA** | `whatsapp/waha-api.ts:34-69` (`wahaFetch`); `config/route.ts:404-410` | Valida a URL com `assertWahaUrlIsSafe` e depois chama **`fetch` cru**: (1) TOCTOU de DNS rebinding; (2) segue redirects sem revalidar e reenvia `X-Api-Key`. `waha_url` é do tenant e **não é validada ao salvar**. | Admin de um tenant aponta `waha_url` para host seu: DNS público na checagem, `169.254.169.254`/`127.0.0.1` no fetch; ou 302 para serviço interno. Leitura direta limitada (QR/avatar exigem `image/*`), mas POST/DELETE em serviço interno é possível (`/api/sessions`). | Trocar por `safeFetch` (`failOnCrossOriginRedirect: true`); validar `waha_url` também no POST de config (400). |
| I-1 | **ALTA** | `scripts/check-schema-readiness.mjs:20`; `.cpanel.yml:8` | `EXPECTED_SCHEMA_VERSION = 143` com migrations até 193; ~11–12 sondas de colunas antigas; `whatsapp_config` nem entra. | Deploy com código da 185/188/192 em banco sem a migration passa no `schema:check` e quebra em runtime (mesma classe do #143). | Gate derivado de `required-migrations.json` + `schema_migrations` (PRD 15 §6.5) e probes geradas do código (6.4). |
| I-2 | **ALTA** | (ausente) `src/types/index.ts` (647 linhas manuais); CI sem schema | **Sem tipos gerados do Supabase, sem `server-only` (pacote nem instalado), sem checagem de schema no CI.** 17 arquivos leem a service role sem barreira de build. Mocks de teste não validam colunas. | **Causa raiz de #143** (telas selecionaram `whatsapp_config.phone_number`/`display_name`; a coluna é `display_phone_number`, mig. 071 → 500) **e de #144** (`validate.ts` no navegador importando `meta-api.ts`→`undici`; editor de fluxos não abria). | Dump do schema live versionado + `supabase gen types` + clientes tipados + job `schema-drift` + `server-only` + regra ESLint/teste de grafo (6.4). |
| R-3 | MÉDIA | `170:108-129`; `blacklist`, `campaigns`, `campaign_metrics`, `disp_message_queue`, `knowledge_base_files` **sem `CREATE TABLE` em migration** | A 170 **pula em silêncio** `knowledge_base_files` se faltar tabela/coluna `account_id`. As 4 do disparador dependem de 040/085/161 na ordem certa. | Sem RLS no live: qualquer pessoa com a anon key (pública) lê/apaga arquivos de conhecimento de todas as contas (A-1 aberto para essa tabela). | Rodar Anexo A-4; se faltar RLS, migration que cria coluna/backfill e habilita RLS, com `RAISE EXCEPTION` em vez de pular. |
| R-4 | MÉDIA | `027_waha_integration.sql:19-21`; `022:38-111`, `007:32-35`, `012:33-36` | A 027 devolveu EXECUTE a `anon`/`authenticated` e **desfez** os REVOKEs de 007/012; `merge_duplicate_contacts` só tem REVOKE de PUBLIC. Nenhum `ALTER DEFAULT PRIVILEGES` em migration alguma. | `anon` chama `merge_duplicate_contacts()` (DEFINER global, custo de CPU) e infla `increment_*_execution_count(uuid)` de qualquer automação/fluxo (se as funções estiverem em `wacrm` no live). | `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role` nas 3 (e dropar `merge_duplicate_contacts`); `ALTER DEFAULT PRIVILEGES` + REVOKE de `anon` em tudo, GRANT explícito por tabela. |
| R-5 | MÉDIA | `161:32-35,41-43` (`get_campaign_stats(uuid[])` EXECUTE a `authenticated`); definição ausente; usos `campaign-status-counts.ts:21`, `v1/.../[id]/route.ts:52` | Se for DEFINER sem checar conta (as irmãs checam `is_account_member`, `054:61,140,180`), há IDOR de contadores por UUID de campanha. | Autenticado de uma conta lê estatísticas de campanha de outra se souber o UUID. | `pg_get_functiondef` no live (A-8); filtrar por `campaigns.account_id` + `is_account_member` ou `REVOKE … FROM authenticated` (as chamadas usam o servidor). |
| AP-01 | MÉDIA | `whatsapp/config/route.ts:936-975` (DELETE), `:997-1110` (PATCH); POST tem guarda `:361-367` | DELETE/PATCH só conferem sessão+conta; **DELETE sem `?id=` apaga todos os canais da conta**. A proteção real é a RLS (admin, mig. 017:423-424, **não confirmada no live**). | Se a policy do live divergir (CLAUDE.md avisa), viewer/agente apaga canais; mesmo com RLS certa, admin apaga todos com um DELETE sem id (a UI `/canais` é owner-only). | `guardRole('admin')` (ou owner) nos dois; exigir `id` (400). |
| AP-02 | MÉDIA | `flows/end-run/route.ts:16-35,52-60` | Só sessão; qualquer papel (viewer) encerra o run ativo de qualquer conversa da conta; `reason` livre; service role; sem rate limit/escopo de equipe. | Viewer em loop derruba os fluxos em andamento. | `guardRole('agent')`, validar visibilidade da conversa (RLS), whitelist de `reason`, rate limit. |
| AP-03 | MÉDIA | `lib/rate-limit.ts:46` (Map); 25 usos | Rate limit **por processo** (B-13). Cada instância do Passenger e cada restart zeram o contador. | N instâncias = N× o limite; deploy libera tudo (afeta `send`, convites, `redeem-by-code` 5/5 min, `v1`, simulador, IA). | RPC compartilhada (6.5). |
| AP-04 | MÉDIA | `next.config.ts:60,68` | CSP `Report-Only` com `unsafe-inline`/`unsafe-eval`, `img-src https:`, sem nonce, sem `object-src 'none'` e **sem `report-to`** (violações só no console). Cookie de sessão sem HttpOnly (browser client lê). | Um XSS (mídia, markdown) lê o token e age com a sessão. | Medir (`report-to`), nonce por requisição, remover `unsafe-eval`, enforçar (6.6). |
| AP-05 | MÉDIA | `next.config.ts:99-101` (`proxyClientMaxBodySize: 50mb`) + `middleware.ts:208-212` | O middleware bufferiza até 50 MB em **toda** rota `/api`, inclusive públicas (webhooks, webchat, convites, `mcp`, `v1`). | POST anônimo de 50 MB em loop esgota memória do processo (DoS) antes de qualquer rota rejeitar. | Excluir do matcher as rotas que não precisam; limite por rota; 50 MB só no import do disparador. |
| AP-06 | MÉDIA | `src/middleware.ts`; `recalculate-metrics/route.ts:12` | Sem checagem de `Origin`/`Sec-Fetch-Site` nem token CSRF (B-11); só `SameSite=Lax`. `GET …/recalculate-metrics` **muda estado**. | Admin que abre link externo dispara o recálculo (GET de topo contorna Lax); fraco contra subdomínios do mesmo site. | Origin same-origin em métodos não seguros (exceto webhooks/cron/v1/mcp); recálculo vira POST (6.6). |
| AP-07 | MÉDIA | `invitations/[token]/peek:45-51`, `redeem:31-37`, `telemetry:28-34` | `getClientIp` duplicado 3×, usa o **primeiro** item de `x-forwarded-for` (forjável); o `clientIp()` seguro já existe em `lib/audit/context.ts:54-60`. | Atacante troca o XFF e zera o limite por IP; `telemetry` grava IP falso em `user_sessions`. | Usar `clientIp()` nos 3 pontos; confirmar no live que o proxy sobrescreve `X-Real-IP`/`X-Forwarded-*`. |
| SG-5 | MÉDIA (já coberta) | — | O achado "qualquer membro lê colunas de segredo direto" é **R-1 + R-2** (mesma causa); a restrição por papel existe só nas rotas (`guardRole('admin')`). | — | Ver R-1/R-2. |
| SG-7 | MÉDIA | `flows/[id]/export/route.ts:12-39,54-68`; `scripts/lib/flow-export.mjs:1-43` | O CLI tem `maskSecrets`; o export da UI não usa nada disso (dois caminhos com garantias diferentes). | Usuário baixa o JSON pela UI e o compartilha com token dentro. | Reaproveitar a mesma máscara; avisar quando houver substituição. |
| SG-8 | MÉDIA | `automations/engine.ts:617-631`; `automations/validate.ts:118-134` | `send_webhook` aceita `headers` arbitrários em texto (sem `{{cred.X}}`) e URL `http:`; validação só checa protocolo; duplicar copia tudo. | Token de terceiro salvo em claro no banco/backup; `http://` vaza o header. | Resolver `{{cred.X}}` (com `allowed_hosts`), bloquear `http:` com header de credencial, `findLiteralCredential` na validação. |
| SG-9 / SW-3 | MÉDIA | `whatsapp/webhook/route.ts:134-179,167-172` | GET de verificação compara `verify_token` com `===` contra **todos** os canais de **todas** as contas (select sem filtro, decrypt de N linhas por GET, sem rate limit); o token de qualquer tenant valida a URL de outro. | DoS barato anônimo (select da tabela + N decrypts por requisição); enumeração por timing (risco baixo). | `matchesOperationalSecret`; rate limit por IP; token único de plataforma (`META_WEBHOOK_VERIFY_TOKEN`, como `meta/webhook/route.ts:27`) ou cache com TTL. |
| SG-11 | MÉDIA | `settings/secrets/route.ts:84-89`; `ai/account-secrets.ts:72-77` | GCM **sem AAD**: o ciphertext da credencial não é amarrado a `account_id`/`name`/`allowed_hosts`. | Quem escreve no banco (service role, DBA) copia a credencial da conta A para a B ou troca `allowed_hosts`. | AAD = `account_id|name` no novo formato versionado (junto da rotação). |
| SG-12 | MÉDIA | `whatsapp/encryption.ts:152-163` | `decryptStoredSecret` trata como "texto puro legado" qualquer string fora do regex GCM/CBC; ciphertext truncado vira token enviado à Meta/WAHA (aviso `console.warn` 1×/processo). | Segredo legado funciona indefinidamente; corrupção vira 401 obscuro. | Medir quantos restam (script/Anexo A-6), depois remover o fallback e falhar fechado. |
| SG-14 | MÉDIA | `ai/responder.ts:119,135,143,1137,1361,1400,1403,1406` | `console.log` com **CPF completo** e corpo da resposta de formalização (boleto/dívida); URL da DDM com `tk=<token>` na query. | CPF/acordo em stdout do Passenger/EasyPanel sem controle de acesso/retenção do CRM; erro de rede com URL vaza o token. | Mascarar CPF (`***.***.***-NN`), não logar corpo; mover token para header se a DDM permitir. |
| SG-16 | MÉDIA | `131_audit_v2.sql:269-276,288-292` | Trigger de auditoria de contatos grava `before/after` de `name, phone, email, company, cpf` e, no DELETE, `phone` e `email` em `audit_logs.changes`. | Pedido de exclusão do titular não apaga CPF/telefone que ficaram em `audit_logs`. | Auditar só "campo alterado" (sem valores) para `cpf`, ou hash/máscara (6.9). |
| SG-18 | MÉDIA | `relatorios/export-with-history.ts:26-45`; `exports/route.ts:83-107` | CSV com valores de contato (nome de perfil do WhatsApp, controlado pelo cliente) sem neutralizar `=`, `+`, `-`, `@`; arquivo gerado no cliente e enviado em base64. | Nome `=HYPERLINK(...)` vira fórmula na planilha de um supervisor. | Prefixar `'`; gerar o arquivo no servidor. |
| SG-19 (M-6) | MÉDIA | `audience/blacklist/route.ts:19-35`; `blacklist-keys.ts:14-24` | Blacklist é **lista única da instância**; a rota recebe até 200 mil telefones e devolve quais estão bloqueados. | Conta A enumera números em opt-out/131026 causados por conta B; inferência sobre bases/reputação de outras contas. | **Decisão do dono** (6.10): sem alterar o bloqueio. |
| SG-21 | MÉDIA | `intelligence/chat/loop.ts:93-150`; `mask.ts:1-12` | `maskPersonalData` só no MCP; o chat interno do Intelligence manda à OpenAI texto de mensagens (até 500 chars/mensagem) sem máscara. | CPF/telefone digitados por clientes seguem para a OpenAI. | Aplicar `maskPersonalData` antes de `toolMessageContent`. |
| SG-22 | MÉDIA | `ai/responder.ts:1131-1190`; `agents/legacy-compose.ts:22-171` | Prompt do agente enviado ao provedor (OpenAI/Claude/Gemini/Hermes) contém nome do devedor, dívida, instituição, parcelas, **CPF** e histórico completo; `api_provider=hermes` usa endpoint configurável (`llm-shared.ts:54,194`). | Dados de devedor saem para terceiro; precisa de base legal/contrato (operador). | **Técnico:** registrar no RIPD/contrato e allowlist para o endpoint `hermes`. **O conteúdo do prompt (o que vai no texto) é *Decisão da operação* — ver 4.1; sem requisito nem PR aqui.** |
| SG-25 | MÉDIA | `contacts/page.tsx:265,310`; `001:75-143`, `127`, `128:167`, `132:23` | Exclusão do titular é DELETE do contato com CASCADE, **sem rotina de atendimento ao titular**: ficam cópias em `flow_run_events.payload`, `flow_runs.vars`, `system_logs.payload`, `audit_logs`, `disp_message_queue.mensagem_final`, `export_history` + Storage, `ai_decisions`. | Titular pede apagamento e restam cópias não localizáveis por `contact_id`. | RPC/rota "anonimizar contato" e "exportar dados do contato" (6.9). Retenção fora do escopo. |
| SW-2 | MÉDIA | `whatsapp/send/route.ts:74`; `v1/whatsapp/send/route.ts:117`; `waha-api.ts:303-338,499-576`; `provider-media.ts:19-21` | `media_url` externa (qualquer http/https) é repassada ao WAHA (`file.url`) e à Meta (`link`) **sem `assertPublicUrl`**; só a v1 de campanhas valida (`campaigns/route.ts:479`). | Integrador manda `media_url=http://servidor-interno/...`: o WAHA compartilhado (`api.meuchatia.com.br`) busca da rede dele (SSRF no lado do WAHA; exfiltração para o WhatsApp do atacante). | `assertPublicUrl` em `resolveProviderMedia`; preferir base64 (`sendWahaMediaMessageBase64`) ou URL assinada interna. |
| SW-4 | MÉDIA | `waha-webhook-auth.ts:73-80`; `waha/route.ts:48-52` | Com `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET=true` o segredo global (que no passado foi gravado no `customHeaders` do WAHA de cada tenant) é aceito sem `?channel=` e a sessão resolvida só por `waha_session`. | Se a flag ficou ligada em produção, **C-3 continua explorável**: tenant que viu o segredo posta `message.any` com `session` de outro tenant. | Desligar a flag assim que as sessões forem reiniciadas; remover o código; alarme se `true` (PRD 15 §10). **Live 13.2-1.** |
| SW-5 | MÉDIA | `meta/webhook/route.ts:37-53`; `waha/route.ts:54` | Sem teto de corpo: `meta/webhook` faz `request.text()`+`JSON.parse` sem teto; `waha` faz `request.json()` sem teto (o WhatsApp tem 1 MB, `:224-233`). | POST de centenas de MB anônimo consome memória do processo único. | Reaproveitar `MAX_WEBHOOK_BODY_BYTES` nas três rotas; HMAC sobre o raw antes do parse. |
| SW-6 | MÉDIA | `whatsapp/webhook/route.ts:945-975`; `waha/route.ts:273-300`; `channels/ingest.ts:40-78` | Replay: sem timestamp/nonce (a Meta não assina timestamp); defesa é idempotência por `message_id`; no WAHA é select-then-insert **não atômico e sem escopo de conta**; reação faz delete+insert. | (1) corrida WAHA; (2) **cross-tenant**: mensagem de outro tenant com o mesmo `message_id` faz responder "already synchronized" e descartar a legítima. | `INSERT … ON CONFLICT`/tratar 23505 como sucesso; índice `(account_id, message_id)`; janela de aceitação de `timestamp`. (Inbox: PRD 15.) |
| AP-08 | BAIXA | `telemetry/route.ts:63-180`; `feedback/route.ts:28-60` | Sem rate limit nem teto de tamanho (B-2); escrevem em `system_logs`/`page_views`/`user_sessions` com service role. | Enchem as tabelas de log. | Limite 60/min por usuário (compartilhado), truncar `message`/`payload`. |
| AP-09 | BAIXA | `lib/auth/api-context.ts:94-104` | Chave inválida é rejeitada **antes** do rate limit: cada tentativa vira consulta ao banco (`findActiveKeyByHash`). | Flood com chaves falsas consome o pool do Supabase (`/api/v1/*`, `/api/mcp`). | Rate limit por IP antes do lookup. |
| AP-10 | BAIXA | `middleware.ts:67-91,181-195`; `whatsapp/external-urls/route.ts:3-8` | O middleware só valida a **forma** do cookie (de propósito); `external-urls` sem auth própria devolve `DISPARADOR_URL`/`LEAD_EXTRACTOR_URL`; `includes('/cron')`/`includes('/webhook')` por substring. | Cookie forjado lê as URLs internas do env. | `getCurrentAccount()` em `external-urls`; prefixos exatos nos matchers. |
| AP-11 | BAIXA | `middleware.ts:135-149`; `dashboard-shell.tsx:34-60`; `role-utils.ts:61-100` | `protectedPaths` não lista várias páginas; o gate de papel por página é **client-side**; `/automations`, `/historico`, `/lead-extractor` sem entrada na allowlist (`canAccessRoute` devolve true). | Shell servido sem sessão e restrição só visual (a proteção real está em RLS e APIs; sem vazamento de dados). | Completar `protectedPaths`; incluir as páginas na allowlist. |
| AP-12 | BAIXA | `campaigns/[id]/info/route.ts:24`; `audience/route.ts:22` | Só `getCurrentAccount`, sem `requireDisparadorAccess`; qualquer papel força `refreshChannelHealth` (Graph + escrita). | Viewer força chamadas à Graph API. | `requireDisparadorAccess()`. |
| AP-13 / SG-10 | BAIXA | `campaigns/[id]/start/route.ts:22-24` | `x-internal-cron === CRON_SECRET` (não constante); caminho praticamente morto (`startCampaign.ts:50`). | Timing em segredo mestre (risco baixo). | Remover o ramo ou `matchesOperationalSecret`. |
| AP-14 | BAIXA | `account/invitations/route.ts:94-129` | Sem `NEXT_PUBLIC_SITE_URL`/`ALLOWED_INVITE_HOSTS`, `isHostAllowed` devolve true: link do convite usa `x-forwarded-host`/`host` do chamador (B-7). | Host-header injection no link do convite (exige admin). | Falhar fechado sem `NEXT_PUBLIC_SITE_URL`. |
| AP-15 | BAIXA | `members/bulk-invite/route.ts:80,143-148` | Senha única por lote, mínimo 6 (reset exige 8). | Convidados do lote partilham senha fraca. | Mínimo 8–12, senha por membro ou convite por link. |
| AP-16 | BAIXA | `account/api-keys/route.ts:50-66` | GET lista as chaves (prefixo/escopo/dono) para qualquer papel (B-6). | Viewer vê quem tem chave e escopo. | Restringir a admin+ (`?mine=1` para os demais). |
| AP-17 | BAIXA | `inbox/conversations/route.ts:46-53`; `flows/[id]/runs/route.ts:70-73`; `inbox/filters.ts:82-84` | Cursor `at` só passa por `Date.parse` e entra em `.or()`; `sanitizeSearch` não remove `"`/`.`. | Injeção de condição no filtro PostgREST (limitada pela RLS do usuário). | `new Date(at).toISOString()`; remover `"`, `.`, `\`. |
| AP-18 | BAIXA | 44 ocorrências de `{error: <obj>.message}` (ex.: `flows/import:171`, `automations/route.ts:23`, `whatsapp/config:518,531`) | `error.message` do banco/provedor volta ao cliente. | Vaza nomes de coluna/constraint. | Mensagem genérica + log (padrão `toErrorResponse`). |
| AP-19 | BAIXA | `webchat/[token]/*` | Limite só por sessão no banco; `GET`/`open`/`media` sem limite por IP (B-12). | Flood de leitura com token válido. | Limite por IP+token no limitador compartilhado. |
| AP-20 | BAIXA | `relatorios/exports/route.ts:53,78` | POST aceita `supervisor` (página é owner/admin); upload até 25 MB só valida extensão. | Supervisor sobe arquivo arbitrário `.xlsx/.csv`. | Alinhar com a política do relatório; magic bytes (`PK`). |
| AP-21 | BAIXA | `src/middleware.ts:7-12` | Fallback do ref do Supabase = `mkrkkvbseobdqsalrorl` (projeto antigo). | Sem env no build o cookie esperado não bate: todos caem em `/login`. | Falhar o build se a env faltar. |
| AP-22 | INFO | `src/middleware.ts` | `middleware` deprecado → `proxy` no Next 16.2.6 (docs `proxy.md:11`). | Só aviso hoje. | Codemod (PRD 15 §6.6). |
| R-6 | BAIXA | `026:68-84`; `154`; `api-keys/route.ts:146-150` | Admin escreve `api_keys` direto pelo PostgREST: contorna `planKeyCreation`, escolhe `scopes`, `key_hash` e `user_id` de **outro** usuário (chave "pessoal" em nome de terceiro). | Chave MCP atribuída a um supervisor; sem escalada real (o servidor recalcula escopo pelo papel do dono). | Revogar INSERT/UPDATE de `authenticated` (usar a rota) ou trigger `user_id IS NULL OR user_id = auth.uid()`. |
| R-7 | BAIXA | `017:633-635` | Admin altera `accounts.owner_user_id` direto (o caminho certo é `transfer_account_ownership`, `018:276`). | Troca o dono lógico fora do fluxo (efeito em convites/seed). | `REVOKE UPDATE … ; GRANT UPDATE (name, default_currency)` (UI só escreve `default_currency`: `deals-settings.tsx:123-126`). |
| R-8 | BAIXA | `028:57`, `029:23`, `030:42`, `035:24`, `036:61`, `038:80` | Funções DEFINER de trigger sem `SET search_path`. | Sem exploração hoje (ninguém cria objeto em schema à frente). | `ALTER FUNCTION … SET search_path = ''` em manutenção. |
| R-9 | BAIXA | `074_whatsapp_test_sends.sql:60-61` | INSERT por qualquer membro (viewer). | Poluição do log do teste de canal. | Exigir `agent`/`admin`. |
| R-10 | BAIXA | `170:80-102` | `disparador_utm_links` gravado pelo service role sem `account_id` fica invisível ao navegador. | UTM "sumido" na UI. Funcional, não segurança. | Backfill por `campaign_id→campaigns.account_id`. |
| R-11 | BAIXA | `hooks/use-total-unread.ts:49` | Realtime com `schema: "public"` (as demais usam `wacrm`). | Badge de não lidas desatualizado. | Trocar para `wacrm`. |
| SG-13 | BAIXA | `whatsapp/encryption.ts:29`; `ci.yml:30` | `process.env.ENCRYPTION_KEY!` lida no import sem validar 64 hex. | Deploy com chave errada só falha ao salvar canal (mensagem genérica). | Validar no boot, falhar com mensagem clara. |
| SG-20 | BAIXA | 44 `NextResponse.json({error: <obj>.message})` | (= AP-18) | — | — |
| SG-23 | BAIXA | `disparador/utm/route.ts:5-31` | `UTM_API_KEY` única da instância (não revogável por conta); `?? ""` envia chave vazia se faltar (não fail-closed); corpo pode ter CPF/telefone (`129_utm_links_cpf.sql`). | Chave compartilhada. | 503 se a env faltar; chave por conta se o terceiro permitir. |
| SG-24 | BAIXA | `ddm-logs/page.tsx:679-683` | `STRESS_RUN_SECRET` digitado em `window.prompt` e enviado pelo navegador (servidor é fail-closed/tempo constante). | Segredo operacional passa pelo navegador de quem opera. | Aceitável; preferir CLI. |
| SW-7 | BAIXA | `whatsapp/media/[mediaId]/route.ts:138,150-156`; `meta-api.ts:1201-1215`; `waha/route.ts:528` | URL de download vem da resposta da Meta (confiança total, sem checagem de host); `.single()` na rota (quebra com várias configs, regra do projeto); `fileKey` sem `encodeURIComponent`. | Só com TLS comprometido; o `.single()` falha em multi-número. | Restringir host de `downloadUrl` (`*.fbcdn.net`/`lookaside.fbsbx.com`/`graph.facebook.com`); `.limit(1)`; `encodeURIComponent`. |
| SW-8 | BAIXA | `whatsapp/templates/sync/route.ts:260` | Segue `paging.next` da Meta com `fetch` cru e Bearer. | Idem SW-7. | Validar que `nextUrl` começa com `META_API_BASE`. |
| SW-9 | BAIXA | `ai/responder.ts:944,1820,1961` | `boundedFetch(media_url)` cru para `messages.media_url`. | Hoje interno (`chat-media`/assinado); caminho futuro com URL externa vira SSRF. | `safeFetch` ou validar host Supabase. |
| SW-10 | BAIXA | `ssrf-guard.ts:296,305-310` | Headers do usuário (http_fetch/tools/send_webhook) vão sem filtro, incluindo `Host`. | Roteamento por virtual host em IP público validado (IP continua público). | Remover `host`, `content-length`, `transfer-encoding`, `connection`. |
| SW-11 | BAIXA | `calls/[...path]/route.ts:25-31` | Proxy VoIP aceitável (allowlist, sem `..`, `redirect:'error'`); corpo sem teto. | Nenhum relevante. | — |
| SG-26 | BAIXA | `.env.local.example`; `middleware.ts:93-105` | `X-Auth-Fx-*` (estado de autenticação e path) em toda resposta: ruído de debug em produção. | Informação inofensiva. | Remover em produção. |

**Totais:** ALTA 11 (R-1, R-2, SG-1, SG-2, SG-3, SG-4, SG-6, SG-15, SG-17, SW-1, I-1, I-2 — I-1/I-2 são ALTA de integridade), MÉDIA ~32, BAIXA ~27. Nenhuma CRÍTICA nova (os críticos da 09 estão corrigidos); **SG-1 é a de maior probabilidade de repetição** (já aconteceu em 08/10).

## 4. Objetivos e não-objetivos

**Objetivos**
1. Nenhum segredo (chave de IA, token/app_secret/verify_token/waha_api_key, credenciais) legível pelo navegador ou por papel baixo — nem em tabela, nem em log, nem em export.
2. Nenhuma credencial literal persistida em fluxo/automação/tool; o incidente do token DDM não se repete (import, export, duplicar, validação, log).
3. Rotação de `ENCRYPTION_KEY` sem downtime e sem fallback silencioso.
4. Dados pessoais (CPF, telefone, dívida) mascarados em logs e exports; atendimento ao titular (exportar/anonimizar).
5. Borda real: rate limit compartilhado, CSRF/Origin, CSP enforçada com nonce, IP confiável, corpo limitado.
6. Integridade: schema live versionado, tipos gerados, `server-only`, CI barrando coluna inexistente e import server→client.
7. RLS/grants/RPCs em matriz auditável com o estado do banco **confirmado**, e migrations como registro do que foi aplicado.

**Não-objetivos:** retenção/expurgo de dados; alterar o comportamento do bloqueio/opt-out (M-6 só muda a **exposição**, sob decisão do dono); mexer em `engine.ts` truncagem/`hasRunLeftNodeSnapshot`; unificar Meta×WAHA; frontend (só contrato, seção 8); mudar `limite_por_hora`.

### 4.1 Decisão da operação (REGRA DO DONO, 08/10) — fora do escopo técnico

Prompt, textos da IA (inclui o fallback "Ben"), personas, quando encerrar conversa, tratamento de ofensa, quando/como propor ou efetivar acordo e régua/mensagens de cobrança **não são escopo deste PRD**. Abaixo, só o **risco técnico** observado; **sem requisito de mudança de comportamento e sem PR**.

| Item (negócio) | Risco técnico observado | Onde |
|---|---|---|
| Conteúdo do prompt do agente (nome do devedor, dívida, instituição, parcelas, **CPF**, histórico completo) | O que está no prompt é dado pessoal enviado a terceiros (OpenAI/Claude/Gemini/Hermes). O requisito técnico fica só nos controles ao redor (RIPD/contrato do operador, allowlist do endpoint `hermes`, máscara em **logs**), nunca no texto do prompt. | SG-22, `ai/responder.ts:1131-1190`, `agents/legacy-compose.ts:22-171` |
| Efetivação de acordo (`efetiva_acordo`) e mensagens de cobrança | Os **argumentos e a resposta** da tool são gravados em log sem máscara (SG-15) e a URL da DDM leva `tk=` na query (SG-14). A correção é **de log/transporte** (máscara, token em header), sem tocar em quando/como o acordo é proposto ou efetivado. | `flows/engine.ts:2461-2503`, `responder.ts:1137,1361,1406` |

A pergunta 13.1-5(d) (CPF no prompt) passa a ser **Decisão da operação**, não requisito.

## 5. Requisitos (com critério de aceite testável)

### 5.1 Funcionais

| ID | Requisito | Aceite |
|---|---|---|
| RF-01 | `authenticated` não tem SELECT nas colunas de segredo de `whatsapp_config` (`access_token`, `app_secret`, `verify_token`, `waha_api_key`) nem em `ai_config` (`api_key`, `elevenlabs_api_key`); escrita de `ai_config` só admin/servidor. | Teste PGlite (`has_column_privilege`) = false; teste de contrato: `select=*` em `whatsapp_config` com JWT de viewer devolve só colunas permitidas (ou 403). Live: Anexo A-6. |
| RF-02 | Importar/duplicar/criar fluxo com credencial literal (header `Authorization`, `tk=`, `api_key`, JWT/hex longo) é **recusado (400)**, com mensagem apontando `{{cred.X}}`; export mascara. | Testes em `flows/import`, `flows/[id]/export`, `POST /api/flows`, `validate.ts` (http_fetch/tools/send_webhook): literal → 400/erro de validação; `{{cred.X}}` → ok. |
| RF-03 | Nenhum log (`flow_run_events`, `system_logs`, stdout, `audit_logs`) contém CPF, token ou corpo de resposta da DDM em claro. | Teste: executar nó `http_fetch`/tool `efetiva_acordo` com CPF/token → `flow_run_events.payload` só tem máscara/resumo; teste de `audit_*` sem valor de `cpf`; grep de `console.log` com CPF = 0. |
| RF-04 | Rotação de `ENCRYPTION_KEY`: anel `ENCRYPTION_KEYS="k2:…,k1:…"`, formato `k2:iv:ct:tag`, script de re-cifra com dry-run/`--apply`/CAS/relatório, HKDF para o `state` OAuth; `tryDecrypt` nunca devolve ciphertext. | Teste: ler valor `k1` com anel `k2,k1`; escrever em `k2`; remover `k1` após re-cifra sem perder leitura; credencial indecifrável → erro explícito + `writeLog` nível error. |
| RF-05 | RPCs `anonymize_contact(contact_id)` e `export_contact_data(contact_id)` (service role, por conta, auditadas) cobrindo `messages`, `flow_runs`, `flow_run_events`, `system_logs`, `audit_logs`, `disp_message_queue`, `export_history`, `ai_decisions`. | PGlite: após `anonymize_contact` nenhuma linha contém nome/telefone/CPF/e-mail do contato; `export_contact_data` devolve JSON completo; outra conta → 404. |
| RF-06 | Rate limit compartilhado entre processos (RPC Postgres) com a mesma assinatura (`success/remaining/reset/limit`, async), usado em login-adjacent (convites), telemetry/feedback, exports, import, lookup de chave inválida, webchat por IP, `end-run`, templates. | Teste: 2 "processos" (instâncias do módulo) compartilham o contador; restart não zera; PGlite da função. |
| RF-07 | Métodos não seguros em `/api/*` exigem `Origin`/`Sec-Fetch-Site` same-origin (exceto webhooks/cron/v1/mcp); `recalculate-metrics` é POST. | Testes de middleware/rota: POST com `Origin` externo → 403; GET `recalculate-metrics` → 405. |
| RF-08 | CSP enforçada com nonce, sem `unsafe-eval`, `object-src 'none'`, `report-to` ativo antes do enforce. | `curl -I` mostra `Content-Security-Policy` (não Report-Only); relatório de violações ≤ limite por 7 dias antes de virar enforce. |
| RF-09 | `clientIp()` único usado em todas as rotas; `getClientIp` removido. | grep `x-forwarded-for` em `src/app/api` = só em `lib/audit/context.ts`. |
| RF-10 | `waha_url` validada ao salvar; `wahaFetch` usa `safeFetch`; `media_url` externa passa por `assertPublicUrl`; headers de usuário sem `Host`. | Testes: `waha_url=http://169.254.169.254` → 400; DNS-rebinding simulado/redirect → bloqueado; `media_url` privada → 422. |
| RF-11 | `verify_token` GET com tempo constante + rate limit por IP; corpo máximo nos três webhooks; HMAC antes do `JSON.parse`; idempotência WAHA atômica e por conta; flag legada WAHA desligada. | Testes de rota; `grep WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET` em prod = ausente/false (live). |
| RF-12 | Papéis: `whatsapp/config` DELETE/PATCH (admin+, `id` obrigatório), `flows/end-run` (agent+), `external-urls` (sessão), `campaigns/[id]/info|audience` (DISP), `api-keys` GET (admin+). | Estender `role-gate.test.ts`/`security-routes.test.ts` com cada rota × papel. |
| RF-13 | Matriz de RLS/grants/RPCs versionada (`docs/security/rls-matrix.md` gerada do dump live) e teste que falha se tabela do schema `wacrm` ficar sem RLS ou com `anon` escrevendo. | Teste sobre `schema.live.json`: `relrowsecurity=true` em tudo; nenhum grant de escrita a `anon`. |
| RF-14 | Schema live versionado + tipos gerados + clientes tipados + job `schema-drift` + `server-only` + regra ESLint/teste de grafo. | Reintroduzir `phone_number` em `whatsapp_config.select` falha em `npm run typecheck` e no CI; reintroduzir import de `meta-api` em `validate.ts` falha em lint e no teste de grafo. |
| RF-15 | `anon`/`authenticated` sem EXECUTE nas RPCs de servidor residuais (R-4/R-5); `ALTER DEFAULT PRIVILEGES` aplicado. | Anexo A-7 retorna só `peek_invitation` (anon) e as RPCs de relatório/membro (authenticated). |
| RF-16 | Export/relatório: leitura de `export_history` e do Storage só supervisor+; CSV neutraliza fórmulas. | Teste PGlite de policy; teste de `export-with-history` com `=cmd` → `'=cmd`. |

### 5.2 Não funcionais

| ID | Requisito | Aceite |
|---|---|---|
| RNF-01 | Rotação sem downtime: durante k2,k1 ativo, taxa de erro de decifra = 0. | Ensaio em staging: contagem de 401/`decrypt failed` = 0 durante a re-cifra. |
| RNF-02 | Rate limit via RPC: ≤ 15 ms p95 por chamada; só em rotas de baixa/média frequência (não nos webhooks de alto volume). | Medição na bancada/staging. |
| RNF-03 | Máscara de PII não pode derrubar a execução do fluxo (falha de máscara = `[redacted]`). | Teste de robustez. |
| RNF-04 | Nenhuma migration deste PRD bloqueia tabela grande: `ALTER`/`REVOKE`/`GRANT` são instantâneos; backfills em lotes. | Revisão de cada migration (sem `UPDATE` único em tabela > 100 mil). |
| RNF-05 | Cada migration traz PRÉ-CHECK que lê o estado vivo (`pg_get_functiondef`, `information_schema`, `has_*_privilege`) e **aborta sem alterar** se o estado divergir. | Padrão da 192; teste PGlite de abortar. |
| RNF-06 | Auditoria: toda mudança de segredo/rotação/anonimização grava `logAuditEvent` com ator e motivo, sem valor do segredo. | Teste de rota. |

## 6. Desenho proposto

### 6.1 RLS, grants e colunas (R-1, R-2, R-6, R-7, R-9, SG-17)
- **Princípio:** `authenticated` só lê o que a UI usa; segredos e escrita sensível só pelo servidor. Migration única por tabela (idempotente, com PRÉ-CHECK), no estilo da 153/169/170.
- `whatsapp_config`: `REVOKE SELECT ON wacrm.whatsapp_config FROM authenticated;` + `GRANT SELECT (id, account_id, provider, phone_number_id, display_phone_number, waba_id, waha_session, waha_url, team_id, client_id, flow_id, receptivo, habilitado, …)`. Lista de colunas **derivada do dump live** (não da migration). Antes: varrer `src/` por `select('*')` em `whatsapp_config` (não achado hoje).
- `ai_config`: `DROP POLICY "Users can manage own AI config"`; criar `ai_config_select` (membro) e escrita só admin; `REVOKE SELECT (api_key, elevenlabs_api_key)` e `REVOKE INSERT, UPDATE` de `authenticated` (a escrita real é pela rota com service role). Backfill de cifra das chaves legadas via script (6.3).
- `accounts`: `REVOKE UPDATE … ; GRANT UPDATE (name, default_currency)`. `api_keys`: `REVOKE INSERT, UPDATE` de `authenticated` (rota com service role) ou trigger de `user_id`.
- `export_history` + Storage `relatorio-exports`: policy supervisor+/criador; `get_export_history` sem `storage_path` para papéis baixos.
- `whatsapp_test_sends`: INSERT por `agent+`.
- `ALTER DEFAULT PRIVILEGES IN SCHEMA wacrm REVOKE ALL ON TABLES/FUNCTIONS FROM anon, authenticated` + REVOKE de `anon` em tudo e GRANT explícito por tabela (consolida a herança da 027). **Só depois** de rodar o Anexo A-2 e checar que nenhuma tabela da UI perde acesso necessário.
- `knowledge_base_files`: migration que cria/valida `account_id`, backfill, RLS; `RAISE EXCEPTION` se o pré-requisito falhar (em vez de pular).

### 6.2 RPCs SECURITY DEFINER (R-4, R-5, R-8)
- Revogar de `PUBLIC/anon/authenticated` e conceder a `service_role`: `increment_automation_execution_count`, `increment_flow_execution_count`; **dropar** `merge_duplicate_contacts` (índice único da 022 a torna no-op).
- `get_campaign_stats(uuid[])`: ler a definição viva; se DEFINER sem checagem, filtrar por conta (`campaigns.account_id` + `is_account_member`) ou revogar de `authenticated`.
- `SET search_path = ''` nas DEFINER de trigger 035/036/038 (manutenção).
- Matriz de RPCs (c.1/c.2 da revisão) vira `docs/security/rls-matrix.md`, gerada do dump live, com teste que falha se surgir DEFINER sem `search_path` ou executável por `anon` fora de `peek_invitation`.

### 6.3 Segredos, credenciais e rotação (SG-1…SG-8, SG-11…SG-14)
**A. Credencial literal em fluxo/automação/tool (SG-1/2/3/7/8).**
1. `git cherry-pick 4d84f10` na `v2` (sem trazer o resto das branches `fix/*`; revisar as outras correções do incidente em `fix/ddm-token-int`, `fix/ia-ferramentas-erro-ddm-token`, `fix/ddm-token-out-of-flows`).
2. `findLiteralCredential` aplicada a **todos** os pontos de entrada: `flows/import`, `flows/[id]/export`, `POST /api/flows`, duplicar/template, `validate.ts` (`http_fetch`, tools do `ai_agent`, `send_webhook`, `set_variable`), `automations` (criar/duplicar/validar). Resultado = **erro** (não warning).
3. Padrões detectados: nomes de parâmetro `tk|token|apikey|api_key|key|secret|access_token|auth|password|pwd|signature`; header `Authorization/X-Api-Key`; valores JWT (`xxx.yyy.zzz`), `Bearer …`, hex/base64 ≥ 24 chars.
4. Log do engine (`engine.ts:3187-3273`): URL sempre sanitizada (remove query ou mascara valores sensíveis e CPF/telefone); `redactSecrets` **incondicional** com a lista de valores conhecidos (cofre da conta).
5. Export da UI = mesmo `maskSecrets` do CLI (`scripts/lib/flow-export.mjs`); aviso ao usuário quando substituir.
6. **Varredura do que já está persistido** (consulta de leitura, só contagem, sem imprimir valores): `flow_nodes.config`, `automations.steps`, `flow_run_events.payload`, `flow_runs.vars`, `system_logs.payload`, `audit_logs.changes` por `Authorization|Bearer|tk=|api_key` (a migration 145 já cobre `ddmacordos.com…tk=`). Ver Anexo A-9.
7. **Confirmar com o dono que o token DDM de 08/10 foi rotacionado na DDM** e em `DDM_ACORDOS_API_TOKEN` (pergunta 13.1).

**B. Rotação de `ENCRYPTION_KEY` sem downtime (SG-6, SG-11, SG-12, SG-13).** Hoje: uma chave, sem versão, formato `iv:ciphertext:authTag` (GCM) e CBC legado de 2 partes.
1. O código aceita `ENCRYPTION_KEYS="k2:<hex>,k1:<hex>"` (a primeira é a ativa); `ENCRYPTION_KEY` continua como `k1` implícito (compatibilidade).
2. Novo formato com id: `k2:iv:ciphertext:authTag` (4 partes). `decrypt` por contagem de partes: 4 = usa o id; 3 = tenta cada chave do anel (a authTag GCM identifica a certa sem falso positivo); 2 (CBC) = só `k1`, deve ser reciclado antes.
3. `encrypt` sempre usa a chave ativa e grava o id. **AAD = `tabela|coluna|account_id`** no formato novo (resolve SG-11).
4. HMAC do `state` OAuth derivado por **HKDF** (rótulo `oauth-state`) e aceitar a assinatura antiga por 10 min (TTL do state) — separação de uso.
5. **Passos operacionais:** (i) deploy do código com anel de uma chave (sem efeito); (ii) adicionar a nova chave **na frente** (`k2,k1`) e reiniciar (`touch tmp/restart.txt`): novos saves saem em k2, leituras antigas seguem; (iii) rodar o script de re-cifra (estende `scripts/encrypt-plaintext-app-secrets.mjs`: dry-run por padrão, `--apply`, compare-and-swap no valor lido, round-trip antes de gravar, relatório por coluna) em `whatsapp_config` (4 colunas), `ai_config` (2), `channels.access_token`, `account_secrets.value_encrypted`; (iv) verificar relatório "0 valores só decifráveis por k1"; (v) retirar k1 **só depois** que backups/PITR que contenham k1 saírem da janela de restauração; (vi) guardar k1 aposentada em cofre fora do servidor até lá.
6. **Falha segura:** `tryDecrypt` não devolve mais ciphertext como segredo; credencial indecifrável em `account-secrets.ts:78-80` gera `writeLog` nível error; após medir (Anexo A-6), remover o fallback de "texto puro legado" (SG-12) e falhar fechado; validar 64 hex no boot (SG-13).
7. **Medir antes:** contar quantas linhas ainda estão em texto puro (dry-run em produção).

**Inventário de segredos** (colunas/env, cifrado?, quem lê, rotação): `whatsapp_config.access_token/app_secret/verify_token/waha_api_key` (cifrados; legado em texto puro possível); `ai_config.api_key/elevenlabs_api_key` (cifrado só pela rota; legado cru; lido com `tryDecrypt`); `channels.access_token` (cifrado; refresh automático Instagram a cada 10 dias); `account_secrets.value_encrypted` (cofre 175); `api_keys.key_hash`/chaves pessoais (SHA-256); `webchat` token (hash); `audit_secrets.header_secret` (texto puro, REVOKE até de `service_role`; deve igualar `AUDIT_HEADER_SECRET`); `flow_nodes.config` e `automations.steps` (**não cifrados — SG-1/2/8**); env: `ENCRYPTION_KEY`, `CRON_SECRET`, `AUTOMATION_CRON_SECRET`, `STRESS_RUN_SECRET`, `DDM_ACORDOS_API_TOKEN`/`DDM_TOKEN`/`DDM_API_KEY`, `WAHA_WEBHOOK_SECRET` (HMAC por canal, nunca enviado ao WAHA), `UTM_API_KEY`, `META_APP_SECRET`, `AUDIT_HEADER_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` (a memória do projeto cita credenciais vazadas do projeto antigo `rpjyrs…`: **trocar se ainda ativas**).

### 6.4 Integridade de dados (I-1, I-2; incidentes #143 e #144)
**Causa raiz #143** (`f67d218`): telas do Disparador (PRs #138–#141) selecionaram `whatsapp_config.phone_number`/`display_name` (inexistentes; a coluna é `display_phone_number`, mig. 071) → PostgREST 500. Não foi pego porque: (1) clientes são `SupabaseClient` sem tipo, `.select("a,b")` é string livre; (2) testes usam banco falso (devolve o que o teste manda); (3) `schema:check` é curado à mão (~11 tabelas) e parado na 143; (4) migrations não são fonte de verdade do live. Pontos hoje com alias: `desempenho/route.ts:49`, `erros.ts:162`, `limits.ts:351,489`, `monitor-snapshot.ts:549`.
**Causa raiz #144** (`a62aeab`): `lib/flows/validate.ts` (navegador) importava `INTERACTIVE_LIMITS` de `lib/whatsapp/meta-api.ts`, que desde o #136 puxa `meta-dispatcher` (`undici`, Node) e o gate da bancada → o bundle do cliente quebrou e nenhum fluxo abria; `next build` do CI passou. A trava atual (`validate-client-safe.test.ts`) só olha imports diretos de **um** arquivo.

**Desenho (ordem: 1 → 3 → 4 → 2 → 5):**
1. **Dump do schema live versionado** — `scripts/schema-dump.mjs` (ou `supabase db dump --schema wacrm --schema-only` com connection string de leitura) gera `supabase/schema.live.sql` e `supabase/schema.live.json` (tabela→colunas/tipos/nullable/enums; funções com assinatura; **grants/policies/RLS** — insumo da matriz do RF-13). Roda após cada migration aplicada e semanalmente. PR que muda migration e não atualiza o snapshot falha. **Aceite:** `git diff supabase/schema.live.json` mostra exatamente as colunas de qualquer migration aplicada.
2. **Tipos gerados e clientes tipados** — `supabase gen types typescript --schema wacrm > src/types/database.ts` (`npm run types:gen`); `createClient<Database,'wacrm'>(…)` nos admin-clients (flows, automations, disparador, account, relatorios), no cliente de servidor e no logger. Migração incremental começando por `whatsapp_config`, `campaigns`, `disp_message_queue`, `messages`, `conversations`; `any` explícito nos demais com contador no CI que só pode diminuir. **Aceite:** reintroduzir `phone_number` em `whatsapp_config.select(...)` falha em `npm run typecheck`.
3. **Checagem de schema no CI (sem banco)** — job `schema-drift`: (a) `scripts/check-select-columns.mjs` percorre `src/**/*.ts`, extrai tabela/colunas de `.from("x")….select("…")` (resolvendo alias `a:b` e `rel(...)`) e compara com `schema.live.json`; falha com arquivo:linha; (b) compara `EXPECTED_SCHEMA_VERSION` com o maior número em `supabase/migrations`; (c) valida que cada coluna de `probes[]` existe no snapshot. No deploy, `schema:check` gera as probes a partir das colunas usadas pelo código contra o banco live. **Aceite:** `git show f67d218^` reprova o job; o atual passa.
4. **`server-only` + varredura server→client** — instalar `server-only` e `import "server-only"` nos módulos que leem `SUPABASE_SERVICE_ROLE_KEY` ou importam `undici`/`node:*` (os 17 de service role, `meta-dispatcher.ts`, `meta-api.ts`, `ssrf-guard.ts`, `loadtest/gate.ts`, `logger.ts`; exceção de teste: alias do vitest para stub). Regra ESLint `no-restricted-imports` para arquivos `"use client"`/`components/**`/`hooks/**` (proibir `@/lib/**/admin-client`, `meta-api`, `meta-dispatcher`, `undici`, `node:*`, `ssrf-guard`). Teste genérico de grafo: percorre os imports a partir de cada arquivo `// client-safe`/`"use client"` e falha ao alcançar `server-only`/`node:*` (generaliza o teste do #144). **Aceite:** reintroduzir o import do #144 falha em lint e no teste de grafo; um Client Component importando `admin-client` quebra o `next build`.
5. **Mocks que validam colunas** — helper `assertColumns(table, selectString)` chamado nos mocks de `db.from(...).select(...)` contra `schema.live.json`. **Aceite:** o teste de `monitor-snapshot` falha com `phone_number`.

**Decisão:** migrations deixam de ser a única fonte de verdade; passam a ser o **histórico**, e o `schema.live` o **estado**. Alternativa descartada: ORM/migrador automático (contraria "migrations manuais no SQL Editor").

### 6.5 Rate limit compartilhado (AP-03, AP-08, AP-09, AP-19, API-04 do PRD 15)
- **Postgres, sem infra nova:** `wacrm.rate_limit_buckets(key text, window_start timestamptz, count int, primary key (key, window_start))` + `rate_limit_hit(p_key, p_limit, p_window_s) returns table(success bool, remaining int, reset_at timestamptz)` com `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING`; chamada por RPC via service role; limpeza por cron existente (`ops`). ~5–15 ms por chamada; **usar em** convites, `redeem`, admin, simulador, `telemetry`/`feedback`, exports, import, lookup de chave inválida (por IP), webchat (IP+token), `end-run`, templates, `v1` (por chave e por conta); **não** nos webhooks de alto volume.
- **Redis** (Upstash ou contêiner no KVM 4): `INCR`+`EXPIRE`, ~1 ms — só se `/api/v1` virar tráfego de dezenas de req/s.
- **Mantém o `Map` como 1º nível** (barra rajadas dentro do processo) e o compartilhado como 2º. Mesma assinatura (`success/remaining/reset/limit`), trocando para async. **Recomendação:** Postgres agora; Redis só sob demanda (pergunta 13.1).

### 6.6 Borda: CSRF/Origin, CSP, IP, corpo (AP-04…AP-07, AP-10, AP-11, AP-14, AP-21)
- **Origin/CSRF:** no middleware/`proxy`, métodos não seguros em `/api/*` exigem `Origin` ou `Sec-Fetch-Site` same-origin, exceto webhooks, crons, `v1`, `mcp`; `recalculate-metrics` passa a POST.
- **CSP:** 3 etapas: (1) `report-to`/`report-uri` + coleta por 7 dias; (2) nonce por requisição (via `proxy`), remover `unsafe-eval`, `object-src 'none'`, `img-src` restrita; (3) enforce. Cookie de sessão: avaliar HttpOnly/`__Host-` junto com o suporte do `@supabase/ssr` (hoje o browser client lê o cookie).
- **IP:** `clientIp()` único; o proxy (EasyPanel/Traefik) deve sobrescrever `X-Real-IP`/`X-Forwarded-*` (**confirmar**).
- **Corpo:** tirar do matcher do middleware as rotas públicas (webhooks, webchat, v1, mcp); 50 MB só no import do disparador (AP-05).
- **Matchers exatos** em vez de `includes('/cron')`/`includes('/webhook')`; `protectedPaths` e `ROUTE_ALLOWLIST` completos; `X-Auth-Fx-*` fora de produção.
- Depende do PR `proxy-next16` do PRD 15 (mesmo arquivo).

### 6.7 SSRF residual (SW-1, SW-2, SW-7…SW-10)
Aproveitar o guard único existente. (a) `wahaFetch` → `safeFetch` (`failOnCrossOriginRedirect`; `safeFetch` só aceita body string/Uint8Array e os payloads já são string); (b) `waha_url` validada no POST/PATCH de config; (c) `resolveProviderMedia` chama `assertPublicUrl` quando a URL não é `chat-media`; (d) headers do usuário sem `Host`/`content-length`/`transfer-encoding`/`connection`; (e) host allowlist para `downloadUrl` da Meta e `paging.next`; (f) `SSRF_ALLOWED_HOSTS`: **auditar o valor em produção** (o guard pula o bloqueio de IP para esses hosts; um tenant que controle um subdomínio liberado contorna a guarda — Anexo A-10). Tabela completa dos `fetch` com URL controlável: 28 pontos mapeados na revisão; 21 passam por guarda, 4 PARCIAL/NÃO (`wahaFetch`, `media_url` envio, `downloadMedia`, `paging.next`), 3 N/A (host fixo).

### 6.8 Webhooks (SW-3…SW-6; C-2/C-3 já corrigidos)
Resumo do estado por webhook (HMAC por canal, `timingSafeEqual`, fail-closed, escopo, replay, tamanho): Meta WhatsApp POST ok (1 MB; sem timestamp, idempotência por `message_id`); Meta GET `===` (SW-3); WAHA ok com ressalva legada (SW-4) e idempotência não atômica (SW-6) e sem teto (SW-5); social com segredo global do app (aceitável: assinatura é do app) sem teto (SW-5) e idempotência por `mid`; webchat é token de canal; crons com segredo operacional. **Replay:** a Meta não assina timestamp; defesa = idempotência atômica (`ON CONFLICT`) + índice `(account_id, message_id)`; para WAHA, rejeitar `message.any` com `timestamp` > 24 h. A durabilidade (inbox) é do PRD 15.

### 6.9 LGPD (SG-14…SG-18, SG-21, SG-22, SG-25)
- **Mapa de dados pessoais por destino:** CPF → `audit_logs.changes` (`131:269`), `flow_run_events` (args e resultado), `flow_runs.vars`, stdout (`responder.ts`), `contact_import_variables`, `utm_links_cpf`, URL da DDM (`?cpf=`), prompt dos provedores de IA, `utmpay`; telefone → `system_logs` (mascarado em webhook/auto-blacklist via `maskPhone`), `audit_logs`, `disp_message_queue`, exports completos; mensagens de clientes → `messages`, OpenAI (chat Intelligence **sem máscara**, agente de IA com histórico completo), ElevenLabs. MCP **já mascara** CPF/CNPJ/telefone por padrão de texto (não cobre nomes).
- **Mascaramento:** `maskPersonalText/Data` hoje só no MCP → aplicar em `flow_run_events` (args/resultado: guardar **resumo**), no chat Intelligence, em `console.log` do `responder.ts`, e padronizar `maskPhone`/`maskCpf`. `audit_logs` de contato: só "campo alterado" para `cpf` (sem valores) e hash/máscara de `phone`/`email` no DELETE.
- **Direitos do titular:** `anonymize_contact` e `export_contact_data` (RF-05) por RPC `SECURITY DEFINER` revogada de clientes, por conta, auditadas; cobrem as tabelas listadas em SG-25. **Opt-out preservado:** a anonimização **não remove** o número da blacklist (a entrada fica como hash/phone_key) — decisão confirmada com o dono (13.1).
- **Terceiros:** documentar no RIPD/contrato os operadores (OpenAI, Anthropic, Gemini, ElevenLabs, DDM, `utmpay`); `api_provider=hermes` com endpoint configurável → allowlist.
- **Retenção: fora do escopo.**

### 6.10 M-6 — blacklist global como oráculo (decisão do dono; sem alterar o bloqueio)
Fatos: `loadBlacklistKeySet` carrega a tabela inteira sem filtro de conta; `POST /audience/blacklist` aceita até 200 mil telefones de qualquer owner/admin e responde **quais** estão bloqueados; envio, import e `startCampaign` usam a mesma lista; a blacklist automática do #42 e a de 131026 alimentam a lista por ação de qualquer conta. O opt-out global é **protetivo** para o titular; o problema é só a exposição entre contas. (Conferir no live se `blacklist` tem `account_id` — a 040 acrescentou, mas `blacklist-keys.ts:7-8` diz que não tem.)
Opções (todas preservam o bloqueio): **A** devolver só a **contagem** de bloqueados (UI remove a marca por linha), limite de volume, rate limit por conta e auditoria; **B (recomendada)** separar `blacklist_conta` (visível à conta, detalhada) de `do_not_contact_global` (aplicada ao envio; a rota só diz "N números serão excluídos no envio"); **C** resposta por número só para telefones que a conta já tem em `contacts`; **D** restringir a números ainda não presentes na conta com teto diário baixo. Passo rápido: A; depois B.

## 7. Dados e migrations

Numeração a coordenar com o PRD 15 (próximo livre: 194; o PRD 15 reserva 194–199). Sugestão para este PRD: **200–209**. Todas manuais, idempotentes, com **PRÉ-CHECK vivo** que aborta sem alterar (padrão 192), `CONCURRENTLY` sozinho.

| Nº (prov.) | O que faz | Ordem vs deploy | CONC. | Rollback |
|---|---|---|---|---|
| 200 | `ai_config`: policy nova + REVOKE de colunas de segredo/escrita (R-1) | ANTES do deploy que remove leituras diretas (se houver); UI só lê `enabled` | não | recriar policy/grants antigos (guardados no cabeçalho) |
| 200b | `whatsapp_config`: `REVOKE SELECT` + `GRANT SELECT (colunas)` (R-2) | ANTES/DEPOIS (nenhuma UI usa os segredos); validar `select('*')` | não | `GRANT SELECT` total |
| 201 | `accounts`/`api_keys`/`whatsapp_test_sends`: grants por coluna e policy (R-6/R-7/R-9) | antes ou depois | não | `GRANT` antigo |
| 202 | RPCs residuais: REVOKE/DROP (`merge_duplicate_contacts`, `increment_*`), `get_campaign_stats` conforme definição viva (R-4/R-5), `SET search_path` das triggers (R-8) | antes ou depois | não | `GRANT EXECUTE` |
| 203 | `ALTER DEFAULT PRIVILEGES` + REVOKE de `anon` consolidado (após Anexo A-2) | **depois** de conferir a matriz | não | `GRANT` por tabela |
| 204 | `knowledge_base_files`: coluna/backfill/RLS com `RAISE EXCEPTION` (R-3) | antes | não | `DISABLE RLS` (emergência) |
| 205 | `export_history`/Storage: policy supervisor+ (SG-17) | antes ou depois | não | policy antiga |
| 206 | `rate_limit_buckets` + `rate_limit_hit` (6.5) | ANTES do código que a chama (código cai no `Map` sem ela) | não | `DROP` |
| 207 | `anonymize_contact` / `export_contact_data` (6.9) | antes | não | `DROP FUNCTION` |
| 208 | `audit_contacts_changes` sem valor de `cpf` (SG-16) | antes ou depois | não | recriar função antiga |
| 209 | índice `(account_id, message_id)` em `messages` (SW-6; combinar com o inbox do PRD 15) | DEPOIS, sozinho | **sim** | `DROP INDEX CONCURRENTLY` |

**Pré-checks (Anexo A):** 1 (profiles/169), 2 (grants), 3 (RLS), 4 (`knowledge_base_files`), 6 (texto puro e privilégios por coluna), 7 (DEFINER), 8 (`get_campaign_stats`), 9 (api_keys/accounts). **Segredos:** antes de qualquer migration que fecha leitura, rodar o dry-run de cifra (6.3) para saber quanto texto puro resta.

## 8. Contrato para o frontend

> Front é de outra pessoa; só consome. O que muda para a UI é pouco — a maior parte é endurecimento invisível. Erros no envelope existente (`{error}` interno; `{error:{code,message}}` na v1). Toda rota nova: `Cache-Control: no-store`, `request_id`.

| Rota / comportamento | Mudança | Papel | Payload / erro | Impacto no front |
|---|---|---|---|---|
| `GET /rest/v1/ai_config` e `/whatsapp_config` (PostgREST direto) | Colunas de segredo deixam de ser legíveis | membro | `select` por coluna: `enabled` (ai_config), colunas não secretas (whatsapp_config); `select=*` em `whatsapp_config` falha ou omite segredos | **Auditar `select('*')`** nos componentes; a UI atual não usa as colunas de segredo |
| `GET/POST /api/account/ai-config` | já admin; GET devolve chave mascarada; erro genérico | admin | `{api_key:"abc…wxyz", has_key:true}` | nenhum |
| `POST /api/flows/import`, `POST /api/flows`, `PUT /api/flows/[id]` | **400** com `{error:{code:'literal_credential', node, field, hint:'use {{cred.NOME}}'}}` quando houver credencial literal | admin | lista de campos infratores (sem eco do valor) | exibir erro por nó no editor (campo + dica) |
| `GET /api/flows/[id]/export` | segredos substituídos por `{{cred.X}}`; header `X-Redacted-Fields: n` | admin | JSON do fluxo | avisar "n campos foram mascarados" |
| `POST /api/settings/secrets/rotate-check` **(novo, opcional)** | relatório de saúde da cifra (quantos valores em k1/k2/texto puro) — só contagens | owner | `{keys:{active:'k2'}, counts:{k2:n,k1:n,plain:n}}` | tela opcional "Saúde da criptografia" |
| `POST /api/contacts/{id}/anonymize` **(novo)** | anonimiza dados do titular (RPC 207) | owner/admin | `{ok:true, tables:{messages:n,…}}`; 404 outra conta; **corpo exige** `{reason, confirm:true}` | botão "Atender pedido do titular" com confirmação e motivo |
| `GET /api/contacts/{id}/export` **(novo)** | exporta tudo do contato (JSON) | owner/admin | arquivo JSON (`Content-Disposition`), auditado | botão "Exportar dados do titular" |
| `POST /api/disparador/campaigns/recalculate-metrics` | GET → POST | admin | `{ok:true}`; GET = 405 | botão deve usar POST |
| `POST /api/disparador/audience/blacklist` | conforme decisão M-6 (A: `{blocked_count}`; B: `{excluded_on_send:n}` sem marcar linhas) | owner/admin | — | ajustar a UI se as marcas por linha forem removidas |
| Todas as rotas de escrita | 403 `origin_mismatch` quando `Origin` externo | — | `{error:{code:'origin_mismatch'}}` | nenhum (mesma origem) |
| Rotas limitadas | 429 `rate_limited` + `Retry-After` | — | `{error:{code:'rate_limited', retry_after_s}}` | mostrar "tente em N s" |
| `whatsapp/config` DELETE/PATCH, `end-run`, `api-keys` GET | papel exigido (403 para quem não tem) | admin+/agent+ | `{error:'forbidden'}` | esconder ações por papel (já vem de `role-utils`) |
| Headers | `Content-Security-Policy` (enforce) | — | — | **Front deve remover scripts/estilos inline sem nonce** e usar o nonce injetado (acompanhar o PR de CSP) |

## 9. Testes e aceite

| Camada | O que prova | Onde |
|---|---|---|
| PGlite (`*.sql.test.ts`, timeouts conforme PRD 15 P-08) | grants por coluna (`has_column_privilege`) de `ai_config`/`whatsapp_config`/`accounts`/`api_keys`; policy de `export_history`; `rate_limit_hit` atômico; `anonymize_contact`/`export_contact_data`; pré-check que **aborta** sem alterar; DEFINER sem `search_path` falha | vitest + migrations reais |
| Unit | `findLiteralCredential` (positivos/negativos), `maskPersonalText`, anel de chaves (k1/k2, CBC legado, AAD), HKDF do `state`, `matchesOperationalSecret` | vitest |
| Rotas | role-gate × rota (estender `role-gate.test.ts` e `security-routes.test.ts`: `whatsapp/config`, `end-run`, `external-urls`, `info`, `audience`, `api-keys`); import/export de fluxo com literal; Origin; 405 do recalculate; `verify_token` tempo constante; corpo > teto → 413 | vitest |
| Segurança de estado vivo | Anexo A (consultas) rodado pelo dono antes/depois de cada migration; resultado anexado ao PR | manual/SQL Editor |
| Staging | ensaio de rotação (k2,k1) com tráfego de teste; `report-to` de CSP por 7 dias; confirmar proxy (IP/Host/corpo) | `omnichannel-v2-desenvolvimento` |
| CI | `schema-drift`, `server-only`, regra ESLint, teste de grafo (6.4) | `.github/workflows/ci.yml` |

**"Blindado" =** (a) viewer não lê segredo por PostgREST (A-6 limpo); (b) import com literal = 400 em todos os caminhos e o `4d84f10` dentro da `v2`; (c) logs sem CPF/token (varredura A-9 = 0 em dados novos); (d) rotação ensaiada em staging; (e) `schema-drift` + `server-only` reprovam #143/#144; (f) matriz de RLS gerada do live sem `anon` escrevendo.

## 10. Observabilidade

| Sinal | Fonte | Limiar | Gravidade | Canal |
|---|---|---|---|---|
| Credencial literal recusada | rota/validator | cada ocorrência | média | `system_logs` (`source:'security'`) + resumo diário |
| Falha de decifra / credencial indecifrável | `account-secrets.ts`, `encryption.ts` | qualquer | alta | `writeLog` error + alerta (PRD 15) |
| `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET=true` | boot | presente | média | `/api/health` (`flags_inseguras`) |
| Assinatura de webhook inválida | `webhook_meta`/`webhook_waha` | > 20/10 min | média | Slack |
| 403 `origin_mismatch` / 429 | middleware | picos | baixa | métrica |
| Violações de CSP | `report-to` | qualquer fora de baseline | média | coleta + revisão semanal |
| Anonimização/exportação de titular | `logAuditEvent` | cada uma | info | `audit_logs` |
| Rotação de chave | script | início/fim/relatório | info | `audit_logs` |
| Drift de schema | CI / `schema:check` | qualquer | alta | CI/deploy |

## 11. Riscos, rollback e plano de implantação

| Risco | Mitigação |
|---|---|
| `REVOKE SELECT` em `whatsapp_config`/`ai_config` quebra uma tela que lê coluna proibida | varredura de `select('*')` e de colunas no código + **staging primeiro**; rollback = `GRANT SELECT` (guardado no cabeçalho) |
| Estado do banco diverge das migrations | PRÉ-CHECK vivo que aborta; Anexo A rodado antes; matriz gerada do dump live |
| Rotação de chave com backup antigo | manter k1 até sair a janela de PITR; guardar fora do servidor; re-cifra com CAS e relatório |
| Recusa de credencial literal quebra fluxos existentes | só recusa em **import/criar/ativar**; fluxos já ativos continuam; varredura de legado com relatório e correção assistida (`{{cred.X}}`) |
| CSP enforce quebra o front | 3 etapas (report → nonce → enforce); janela de 7 dias; rollback = voltar a Report-Only (flag) |
| Origin check bloqueia integrações legítimas | exceções explícitas (webhooks, cron, v1, mcp); modo `report` por 1 semana |
| Anonimização apaga opt-out por engano | opt-out (blacklist) fica fora da rotina; teste dedicado |
| `ALTER DEFAULT PRIVILEGES` revoga acesso necessário | só após A-2; GRANT explícito por tabela; staging |

**Ordem de implantação:** 1) hotfixes sem migration (SG-4, SG-9/10, SG-13, `4d84f10`, AP-01/02/07/10/12, SW-1) → 2) rodar o Anexo A e decidir o que é real no live → 3) migrations 200/200b/202 (R-1/R-2/R-4/R-5) em staging → produção → 4) `rate_limit` (206) → 5) LGPD (207/208 + mascaramento) → 6) schema-drift/`server-only`/tipos → 7) rotação de chave → 8) CSRF/CSP.

## 12. Fases e PRs

Tamanho: P ≤ 1 dia, M 2–4, G > 4. Todos com **base `v2`** (sem empilhar).

| # | PR | Conteúdo | Dep. | Dono | Tam. |
|---|---|---|---|---|---|
| 14.1 | `hotfix-incidentes` | cherry-pick `4d84f10` na `v2` + varredura literal em import/export/duplicar/validate (SG-1/2/7/8) + sanitizar `logUrl`/`redactSecrets` (SG-3) | — | BE | M |
| 14.2 | `hotfix-bordas-rapidas` | SG-4 (`dispatch-kick`), SG-9/10 e AP-13 (`matchesOperationalSecret`), SG-13 (validar `ENCRYPTION_KEY`), AP-01/02/10/12/16 (papéis), AP-07 (`clientIp`), AP-21 (sem fallback de ref), `waha_url` validada + `wahaFetch→safeFetch` (SW-1), headers sem `Host` (SW-10), `media_url` guardada (SW-2) | — | BE | M |
| 14.3 | `live-audit` (OPS/dono) | rodar Anexo A e anexar o resultado; decidir R-3/R-4/R-5 | — | OPS | P |
| 14.4 | `rls-segredos` | migrations 200/200b/201 (`ai_config`, `whatsapp_config`, `accounts`, `api_keys`, `whatsapp_test_sends`) + testes PGlite + varredura `select('*')` | 14.3 | BE+dono | M |
| 14.5 | `rpcs-residuais` | migrations 202/203/204 (R-3/R-4/R-5/R-8, default privileges, KB) | 14.3 | BE+dono | M |
| 14.6 | `export-policy-csv` | migration 205 + CSV sem fórmula + export no servidor (SG-17/18) | 14.3 | BE | M |
| 14.7 | `logs-sem-pii` | máscara em `flow_run_events`/`responder.ts`/Intelligence; `audit_contacts_changes` (208) | — | BE | M |
| 14.8 | `lgpd-titular` | migration 207 + rotas `anonymize`/`export` + testes + opt-out preservado | 14.7 | BE | G |
| 14.9 | `rate-limit-compartilhado` | migration 206 + `rate-limit.ts` async + migração das rotas (AP-03/08/09/19) | 14.3 | BE | M |
| 14.10 | `webhooks-endurecidos` | `verify_token` constante + rate limit (SW-3), teto de corpo (SW-5), HMAC antes do parse, idempotência WAHA atômica+escopo (SW-6, índice 209), flag legada off + alarme (SW-4) | 14.9 | BE | M |
| 14.11 | `schema-live-tipos` | `schema-dump`, `schema.live.json`, `gen types`, clientes tipados (incremental), `check-select-columns` | PRD 15 §6.5 | BE | G |
| 14.12 | `server-only-grafo` | `server-only` + ESLint + teste de grafo + `assertColumns` nos mocks | 14.11 | BE | M |
| 14.13 | `rotacao-chave` | anel de chaves, formato v2 com AAD, HKDF, script de re-cifra, `tryDecrypt` seguro, remover fallback legado após medir | 14.4 | BE+OPS | G |
| 14.14 | `csrf-origin-csp` | Origin check, recalculate→POST, matchers exatos, CSP (report → nonce → enforce), `protectedPaths`/allowlist | PRD 15.15 | BE | G |
| 14.15 | `blacklist-m6` | opção A e depois B conforme decisão | decisão do dono | BE | M |
| 14.16 | `matriz-rls` | `docs/security/rls-matrix.md` gerada do dump + teste de RLS/grants | 14.11 | BE | P |

## 13. Perguntas ao dono e itens "A confirmar no live"

### 13.1 Perguntas ao dono (decisão)
1. **Token DDM (08/10):** foi **rotacionado na DDM** e em `DDM_ACORDOS_API_TOKEN`? Posso levar o `4d84f10` para a `v2` agora (hotfix 14.1)?
2. **M-6 (blacklist global):** qual opção — A (só contagem), B (lista da conta × lista global aplicada ao envio, sem dizer quais) ou C/D? (Não altero o bloqueio nem o opt-out automático do #42.)
3. **Segredos legíveis:** posso fechar `SELECT` de segredos em `whatsapp_config`/`ai_config` para o navegador (R-1/R-2)? Alguém usa o Supabase direto (script, BI, planilha) com a anon key lendo essas tabelas?
4. **Papéis:** `viewer` pode enviar mensagens (`whatsapp/send`, `react`)? Quem pode ler/baixar `export_history` (hoje qualquer membro; proposto supervisor+)? `GET api-keys` só admin+?
5. **LGPD:** (a) aceita a rotina "anonimizar contato" **mantendo** o número na blacklist (opt-out) como hash/phone_key? (b) quem é o encarregado/ponto de contato para os pedidos do titular? (c) há RIPD/contratos de operador para OpenAI/Anthropic/Gemini/ElevenLabs/DDM/utmpay? (d) *Decisão da operação (não é requisito técnico):* a operação define o que vai no prompt (ex.: CPF no texto ou só via tool) — o PRD só registra o risco.
6. **Rotação de chave:** janela de manutenção aceitável? Por quanto tempo guardar os backups/PITR que contêm a chave antiga? Onde guardar k1 aposentada (cofre fora do servidor)?
7. **Rate limit:** Postgres (zero infra, recomendado) ou Redis (Upstash/KVM)? Há integrador previsto que gere dezenas de req/s na API v1?
8. **CSP:** aceita 1 semana em modo report antes do nonce/enforce? Quem do front corrige os scripts inline?
9. **`SSRF_ALLOWED_HOSTS` e WAHA interno:** algum tenant usa `waha_url` com IP interno legítimo? Qual o valor em produção? A flag `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET` já pode ser desligada (todas as sessões WAHA reiniciadas com `?channel=`)?
10. **Credenciais do projeto antigo** (memória: `rpjyrs…` vazadas): ainda ativas? Rotacionar `SUPABASE_SERVICE_ROLE_KEY` se sim.
11. **`UTM_API_KEY` única:** o terceiro (`utmpay`) permite chave por conta?
12. **Hermes/LLM customizado:** manter endpoint configurável por conta ou restringir a allowlist?

### 13.2 A confirmar no live (resumo; consultas exatas no Anexo A)

| # | O que | Item |
|---|---|---|
| 1 | `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET`, `SSRF_ALLOWED_HOSTS`, `META_APP_SECRET`/`INSTAGRAM_APP_SECRET`, `NEXT_PUBLIC_SITE_URL`, `ALLOWED_INVITE_HOSTS`, `AUDIT_HEADER_SECRET`×`audit_secrets` | SW-4, AP-14, SG |
| 2 | Migration 169/170/174 aplicadas; estado real de RLS/grants/policies/DEFINER (A-1…A-3, A-5, A-7, A-8) | C-1, A-1, A-9 |
| 3 | `knowledge_base_files` e as 4 tabelas do disparador sem `CREATE TABLE` (A-4) | R-3 |
| 4 | Texto puro restante (`app_secret`, `verify_token`, `waha_api_key`, `access_token`, `api_key`, `elevenlabs_api_key`) — só contagens (A-6) | R-1, R-2, SG-12 |
| 5 | `blacklist` tem `account_id` no live? RPC `blacklisted_phone_keys` filtra conta? | SG-19 |
| 6 | Proxy EasyPanel/Traefik: repassa `Host` arbitrário? sobrescreve `X-Real-IP`/`X-Forwarded-*`? limite de corpo? | SG-4, AP-05, AP-07 |
| 7 | Número de instâncias do Passenger | AP-03 |
| 8 | CDN guarda HTML autenticado (`s-maxage=300`)? (`curl -I` numa página do dashboard) | AP-04/CSP |
| 9 | Cookie de sessão em produção (`SameSite`, `Secure`, domínio) | AP-06 |
| 10 | `flow_nodes.config`/`automations.steps`/`flow_run_events`/`flow_runs.vars`/`system_logs`/`audit_logs` com token/Authorization literal (contagens, A-9) | SG-1/3 |
| 11 | Índice único de `messages.message_id` (global ou composto) — decide a gravidade de SW-6 | SW-6 |
| 12 | Se o DDM aceita o token em header (evita `tk=` na URL em access logs) | SG-14 |
| 13 | Policies de `export_history` e `storage.objects` (bucket `relatorio-exports`) | SG-17 |
| 14 | Limites de login do Supabase Auth (sign-in, recover, OTP) e política de senha | AP-03 |
| 15 | Storage (`avatars`, `flow-media`, `chat-media`, `exports`) e Realtime (publicação) | fora das fatias; mesma anon key |

---

## Anexo A — Consultas para o SQL Editor (somente leitura)

Rodar no projeto de produção `cyftbffhgjmsfogxawrl` (e no de desenvolvimento) **antes** de cada migration deste PRD e anexar o resultado ao PR. Nada foi executado nesta revisão. **Nunca imprimir valores de segredo — só contagens.**

**A-1 `profiles` (C-1):** a 169 foi aplicada?
```sql
SELECT column_name,
  has_column_privilege('authenticated','wacrm.profiles',column_name,'UPDATE') AS can_update,
  has_column_privilege('authenticated','wacrm.profiles',column_name,'INSERT') AS can_insert,
  has_column_privilege('anon','wacrm.profiles',column_name,'UPDATE') AS anon_update
FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='profiles' ORDER BY ordinal_position;
SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='wacrm.profiles'::regclass AND NOT tgisinternal;
-- esperado: can_update só em full_name/avatar_url; can_insert tudo false; trigger profiles_guard_privileged_columns habilitado
```
**A-2 grants reais por tabela e default privileges:**
```sql
SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema='wacrm' AND grantee IN ('anon','authenticated') GROUP BY 1,2 ORDER BY 1,2;
SELECT defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl FROM pg_default_acl;
-- procurar: anon com INSERT/UPDATE/DELETE; tabela de segredo/servidor com authenticated
```
**A-3 RLS ligado em tudo e policies:**
```sql
SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
  (SELECT count(*) FROM pg_policies p WHERE p.schemaname='wacrm' AND p.tablename=c.relname) AS n_policies
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='wacrm' AND c.relkind IN ('r','p','v','m') ORDER BY c.relrowsecurity, c.relname;
SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='wacrm' AND c.relkind='v';   -- views sem security_invoker=true
SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname='wacrm' ORDER BY tablename, cmd, policyname;
```
**A-4 `knowledge_base_files` e tabelas sem `CREATE TABLE`:**
```sql
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='knowledge_base_files' ORDER BY ordinal_position;
SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
 WHERE schemaname='wacrm' AND tablename IN ('knowledge_base_files','campaigns','disp_message_queue','campaign_metrics','blacklist') ORDER BY tablename, policyname;
```
**A-5 `api_keys` e `accounts` — grants de escrita por coluna:**
```sql
SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
WHERE table_schema='wacrm' AND table_name IN ('api_keys','accounts') AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE');
```
**A-6 segredos: privilégio por coluna e texto puro restante (só contagens):**
```sql
SELECT column_name, has_column_privilege('authenticated','wacrm.whatsapp_config',column_name,'SELECT') AS sel
FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='whatsapp_config';
SELECT column_name, has_column_privilege('authenticated','wacrm.ai_config',column_name,'SELECT') AS sel
FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='ai_config';
-- formato cifrado do projeto: hex "iv:ciphertext:authTag"; texto puro = fora desse padrão
SELECT count(*) FILTER (WHERE app_secret IS NOT NULL AND app_secret !~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$') AS app_secret_plain,
       count(*) FILTER (WHERE verify_token IS NOT NULL AND verify_token !~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$') AS verify_token_plain,
       count(*) FILTER (WHERE waha_api_key IS NOT NULL AND waha_api_key !~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$') AS waha_key_plain,
       count(*) FILTER (WHERE access_token IS NOT NULL AND access_token <> 'waha-placeholder' AND access_token !~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$') AS access_token_plain
FROM wacrm.whatsapp_config;
SELECT count(*) FILTER (WHERE api_key IS NOT NULL AND api_key !~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$') AS ai_key_plain,
       count(*) FILTER (WHERE elevenlabs_api_key IS NOT NULL AND elevenlabs_api_key !~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$') AS eleven_key_plain
FROM wacrm.ai_config;
```
**A-7 funções DEFINER: search_path e ACL real; executáveis por anon/authenticated:**
```sql
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.proconfig,
       (SELECT array_agg(coalesce(NULLIF(a.grantee,0)::regrole::text,'PUBLIC')||':'||a.privilege_type)
          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('wacrm','public') AND p.prosecdef ORDER BY n.nspname, p.proname;
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('wacrm','public')
  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ORDER BY p.prosecdef DESC, n.nspname, p.proname;
-- específicos: merge_duplicate_contacts, increment_automation_execution_count, increment_flow_execution_count, get_campaign_stats, set_member_role (anon?), peek_invitation (só esta deve ter anon)
```
**A-8 definição de `get_campaign_stats` e `is_account_member` (qual cópia vale):**
```sql
SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='wacrm' AND p.proname IN ('get_campaign_stats','is_account_member');
```
**A-9 varredura de credencial literal já persistida (só contagem):**
```sql
SELECT count(*) AS flow_nodes_suspeitos FROM wacrm.flow_nodes
 WHERE config::text ~* '(authorization"\s*:\s*"[^"{]|bearer\s+[A-Za-z0-9._-]{16,}|[?&](tk|token|api_?key|access_token)=[A-Za-z0-9._-]{12,})';
SELECT count(*) AS automations_suspeitas FROM wacrm.automations
 WHERE steps::text ~* '(authorization|bearer\s+[A-Za-z0-9._-]{16,}|[?&](tk|token|api_?key)=[A-Za-z0-9._-]{12,})';
SELECT count(*) AS run_events_suspeitos FROM wacrm.flow_run_events
 WHERE payload::text ~* '[?&](tk|token|api_?key)=[A-Za-z0-9._-]{12,}';
-- repetir (com LIMIT/janela de datas se a tabela for grande) para flow_runs.vars, system_logs.payload e audit_logs.changes
```
**A-10 ambientes expostos e storage/realtime (mesma anon key):**
```sql
SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('authenticator','anon','authenticated','service_role');
SELECT id, public FROM storage.buckets;
SELECT policyname, cmd, roles, qual FROM pg_policies WHERE schemaname='storage' AND tablename='objects';
SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY 1,2;
SELECT wacrm.app_schema_version();   -- esperado >= 193 (hoje 143: ver I-1)
```
(Variáveis de ambiente — `SSRF_ALLOWED_HOSTS`, `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET`, `NEXT_PUBLIC_SITE_URL`, `ALLOWED_INVITE_HOSTS`, `META_APP_SECRET`, `INSTAGRAM_APP_SECRET`: conferir no painel do EasyPanel; `AUDIT_HEADER_SECRET` deve igualar `wacrm.audit_secrets` — compare por função de verificação, **sem expor** o valor.)
