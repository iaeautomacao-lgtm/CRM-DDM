# PRD 13 — IA, fluxos e agentes (V2 backend)

Base verificada: `origin/v2` @ `4fbbbfe` (08/10/2026), worktree `wt-ancora-prd13`. Somente leitura; nada foi executado contra o banco live. Tudo que depende do banco/produção está marcado **"A confirmar no live"**.
Escopo: motor de fluxos (`src/lib/flows/engine.ts`), cron/watchdog, responder (`src/lib/ai/responder.ts`), perfis de agente (fases 1–4 do #113), simulador (#60), tabulação automática (#71/#77), travas (xingamento/loop/intenções prioritárias), integração DDM e o incidente de 08/10 (TASK25).
Fora de escopo: retenção de dados; truncagem do engine e `hasRunLeftNodeSnapshot` (intocáveis); `limite_por_hora`.

---

## 1. Resumo

- **Problema:** a IA/fluxos têm bons pilares (versão de agente fixada por run, semáforo/429, recuperação de tool, travas determinísticas), mas ainda há (a) caminhos que tratam erro da DDM como sucesso e que espalham o token em texto, (b) efeitos colaterais reais disparados por heurística de texto livre e por retry do modelo, (c) cron de fluxos sem isolamento de falha, (d) pendências dos perfis de agente (KB por agente real, RAG, conversão em produção com runs ativos) e (e) decisões de negócio da operação (acordo por texto, encerramento automático, xingamento, textos de fallback), que ficam **fora do escopo técnico** (seção 14).
- **Objetivo:** blindar a integração DDM e o ciclo de vida do run, fechar as pendências dos agentes sem mudar o comportamento de produção sem decisão do dono, e entregar ao front um contrato estável.
- **Ganho:** zero "erro vira sucesso" silencioso; zero token em texto no banco/export/import; nenhuma ação irreversível (formalizar acordo) por regex de texto ou por retry; fluxo/cron que não travam um run por exceção alheia.
- **Ponto de atenção de processo:** a TASK25 (classificação do erro aninhado da DDM, saneamento do `tk=` na importação, `findInlineSecrets` → erro) foi feita na **main (V1)** — `origin/v2` **ainda não a tem** (confirmado: `src/lib/ai/tool-recovery.ts` na v2 não tem `ERRO`/`TOOL_AUTH_ERROR`; `src/app/api/flows/import/route.ts` não sanitiza). Este PRD assume trazê-la para a v2 (PR-0) e estendê-la ao modelo de credenciais da v2 (`{{cred.X}}`).

---

## 2. Estado atual (com arquivo:linha)

### 2.1 Motor de fluxos
- `engine.ts` (5.019 linhas). Entradas: `dispatchInboundToFlows` (4010) → `handleReplyForActiveRun` (4258) / `startNewRun` (4754) / `startTransferredRun` (4871) / `startWebchatRun` (4944); caminhada de nós em `advanceFromNodeKey` (2716); IA em `runAiAgentCore` (2164).
- Um run ativo por contato/conta (índice parcial `idx_one_active_run_per_contact`, cobre `active` e `paused_by_agent`; comentário em `engine.ts:251-279`). `loadActiveRunForContact` usa `.limit(1)` (regra do projeto) e encerra run órfão sem `conversation_id` (`engine.ts:296-307`).
- **Debounce da resposta da IA**: RPC `bump_ai_agent_debounce` (migration 090), espera 4 s e relê `debounce_until` (`engine.ts:4201-4222`); fallback em memória (`engine.ts:4161-4176`) se a RPC falhar — **não coordena entre processos Passenger**.
- Guard anti-race `hasRunLeftNodeSnapshot` (`engine.ts:4243`, usado em 4300 e 4388) — **não tocar**.
- Eventos: `logRunEvent` (421) em `flow_run_events`; decisões da IA em `ai_decisions` (`logAiDecision` 497; migration 134). `tool_result` guarda até 8.000 caracteres do corpo bruto (`engine.ts:2481`) e `tool_called` guarda os `args` (CPF) (`engine.ts:2448-2460`).
- Status do evento `tool_result`: `error` somente se o corpo é JSON com `error: string` (`parseToolFailure`, `engine.ts:554-568`). Resposta `[{"ERRO":{"ERRO":"TOKEN INVALIDO"}}]` não casa → **status `success`** (origem do incidente).
- Handoff: `executeHandoff` (1241), `executeHandoffAgent` (1357), `executeHandoffTeam` (1658); escolha de atendente `selectAgentForTeam` (1452-1570: filtra `account_role='agent'`, presença online→away com janela de 75 s, menor carga, respeita `max_simultaneous_chats`, overflow recursivo).

### 2.2 Cron de fluxos (`src/app/api/flows/cron/route.ts`)
- `POST`: auth por `x-cron-secret` em tempo constante (linhas 34-51); (1) varre runs paradas via RPC `sweepable_flow_runs(p_limit 200)` (61) e marca `timed_out` conforme `fallback_policy.on_timeout_hours` (padrão 24 h); (2) acorda runs `delayed` com `wake_at <= now` (**limite 20**, linha 122) e avança; (3) `sweepStalledAiConversations` (167).
- `GET` é só health check (175-184).

### 2.3 Watchdog da IA (`src/lib/flows/ai-watchdog.ts`)
- Janela: `AI_STALL_SECONDS` (**padrão 180 s**, linha 47; o cabeçalho do cron fala em ~90 s — comentário desatualizado em `cron/route.ts:164-166`) e `AI_STALL_MAX_MINUTES` 30. Candidatas: conversas `open`, sem agente, sem resposta, `limit(50)` (linha 75). Para cada uma faz ~4 consultas (respostas, run ativa, tipo do nó) e só então decide; se for nó de IA, encerra o run `handed_off`/`ai_response_stalled`, põe a conversa em `pending` e grava `ai_decisions`.

### 2.4 Responder (`src/lib/ai/responder.ts`, 2.418 linhas)
- Pipeline: intenções prioritárias determinísticas (760-796: opt-out e pessoa errada gravam em `blacklist`), trava de ofensa/jailbreak (807-843), anti-loop do bot (846-895), KB (1081-1122), RAG externo opcional (1165-1175), provider (1200-1226), retry de resposta vazia (1251-1254), `#INSTABILIDADE` forçada (1271-1280), fallback de texto fixo (1297-1299).
- OpenAI: laço de tools com **5 iterações** (`responder.ts:2008`); `gatedFetch` (semáforo por processo `AI_LLM_MAX_CONCURRENCY` 20, fila 60 s, 429 com `Retry-After`: `llm-gate.ts:26-39,164`); `max_tokens` 1000 e `temperature` 0.7 fixos (2014-2015); **Claude/Gemini/Hermes não usam `gatedFetch` nem tools** (`responder.ts:2330-2418`).
- Tools: `maxAttempts = 3` (2170) com retry só de `localizar_devedor`/`consultar_debitos` GET (`tool-recovery.ts` `SAFE_RETRY_TOOLS`); classificação em `classifyHttpFailure`/`classifyToolBodyFailure` (`tool-recovery.ts:128-214`); contagem por tool e `#INSTABILIDADE` só se **todas** as chamadas da rodada caíram (`tallyToolResult`/`fullyFailedIntegrations`, `tool-recovery.ts`); credencial ausente → `TOOL_PROVIDER_ERROR` não retentável (`responder.ts:2147-2160`).
- Segredos: `{{secret.DDM_TOKEN}}` (env), `{{cred.X}}`/`{{var.X}}` (cofre `account_secrets`, migration 175, host da URL **final** valida `allowed_hosts`), carregado por chamada de tool (`account-secrets.ts` — trocar/apagar vale na hora).
- Heurística legada de acordo (`responder.ts:1318-1331`): texto do modelo contendo "dados do acordo", "confirmar os dados", "acordo formalizado", "geração do boleto" ou "boleto oficial" marca `hasAgreedAcordo`; se não há override do nó (`!hasOverride`) e há CPF no histórico, o responder **chama a DDM por conta própria** (`localiza_dev`, `calc`, `CalculaDebitos.php` — 1370-1406) com o token em texto na URL.

### 2.5 Perfis de agente (#113, migrations 177/179/180/182; `src/lib/ai/agents/*`, `src/lib/flows/agent-binding.ts`)
- Modelo: `ai_agents` → `ai_agent_versions` (config JSON validada por `schema.ts`, `config_hash`) + regras versionadas (`ai_rules`/`ai_rule_versions`/`ai_agent_rules`) + ferramentas (`ai_agent_tools`) + conhecimento (`ai_agent_knowledge`). Publicar/reverter/excluir por RPC `publish_ai_agent`/`rollback_ai_agent`/`delete_ai_agent` (service_role).
- Runtime: nó com `agent_id` → `resolveBoundAiNode` (`agent-binding.ts:99-121`) usa a **versão fixada no run** (`flow_run_agent_bindings`, migration 179; `snapshotRunAgentBindings` ao iniciar o run); sem snapshot, fixa a publicada naquele momento; agente desligado/inexistente → `disabled` → saída de falha/handoff. Liga/desliga vale na hora, inclusive para runs em andamento (`agent-binding.ts:131-135`).
- Serviço `agents/service.ts`: `listAgents` (301), `getAgent` (374), `publishAgent` (532), `rollbackAgent` (571), `patchAgent` (594), `deleteAgent` (620), `previewAgent` (629). `prepare` (470) rejeita credencial literal na conexão/ferramenta/RAG (`service.ts:156-174` via `findLiteralCredential`).
- Conversão do legado: `agents/convert.ts` + `scripts/convert-ai-nodes-to-agents.mjs` (dry-run por padrão; só preenche `agent_id` em fluxo sem run `active`/`paused_by_agent`: `scripts/…mjs:9,41,223`).
- KB: `knowledge.selection_mode` `legacy_account_all` | `explicit` (+`file_ids`); `kb-context.ts` (teto `AI_KB_MAX_CHARS` 40.000, ranking por sobreposição de termos, sem vetor). RAG externo opcional atrás de flag `AI_EXTERNAL_RAG_ENABLED` e credencial `{{cred.X}}` (`agents/external-rag.ts`).

### 2.6 Simulador (#60) — `POST /api/flows/[id]/simulate`
- Supervisor+; roda o motor real com o **rascunho**, efeitos simulados, tools mockadas, leitura real só admin/owner (`applyRealReadPolicy`); rate limit `SIM_RATE_LIMIT` 30 msgs/10 min **em memória do processo** (`simulate/route.ts:104`, `simulator/types.ts:151`); stateless (o cliente reenvia o estado).

### 2.7 Tabulação automática (#71/#77)
- `suggestOutcomeTag` (`tabulacao-suggest.ts:224`, GET `/api/conversations/[id]/suggest-tag`): sugestão por tag de saída → cache → LLM com "incerto". `applyExitTagOutcomeSuggestion` (`outcome-suggestion.ts:63`): grava **sugestão** e **só fecha a conversa** se a linha de `ai_exit_tag_outcome_map` tiver `auto_close=true` e a conversa não tiver tabulação (`outcome-suggestion.ts:102`); nunca mexe em tabulação humana/conversa fechada. O cabeçalho registra: "**DECISÃO DE PRODUTO PENDENTE**".
- `acordo-tagging.ts` (código 142 "Acordo realizado", confiança 0,9) dispara por debounce de 15 s em **timer em memória** (`acordo-trigger.ts:15-20,27-46`) — perde em restart/multi-worker (aceito no comentário; best-effort).

### 2.8 Travas
- `abuse-guard.ts`: lista de termos (palavra inteira, sem acento) → **transferência imediata** para a fila da equipe (`responder.ts:807-843`, `team-handoff.ts`), sem aviso nem desescalada; não dispara se a mensagem também é intenção prioritária (807: `priorityIntent ||` → `null`).
- `loop-guard.ts`: ≥8 msgs do bot em 120 s → handoff (846-895). `priority-intents.ts`: opt-out, pessoa errada, pedido de humano, contestação.

---

## 3. Problemas e riscos

| ID | Sev. | Onde | Problema | Cenário de falha | Correção |
|---|---|---|---|---|---|
| IA-01 | **CRÍTICA** | `tool-recovery.ts:214-262` (v2); `engine.ts:554-568` | Corpo `[{"ERRO":{"ERRO":"TOKEN INVALIDO"}}]` não é reconhecido: `classifyToolBodyFailure` só olha chave `error` minúscula no topo; `parseToolFailure` idem. Vira `success`, vai à IA como dado. | Token inválido/rotacionado → IA "negocia" com dados inexistentes; `flow_run_events` mostra sucesso (incidente 08/10). | Portar TASK25: chave `ERRO/erro/error` (qualquer caixa), aninhada, array de 1; `TOOL_AUTH_ERROR` não retentável e contado como indisponibilidade; mensagem genérica sem token. `parseToolFailure` passa a usar o mesmo classificador. |
| IA-03 | **ALTA** | `responder.ts:1251-1254` | Retry "resposta vazia" chama `callProvider` de novo **depois de tools já executadas** (`tracker.externalEffect` só protege a liberação do claim, `:493`). O laço de 5 iterações esgotado devolve `""` (`:2327`), então o retry reexecuta até +5 iterações. | Modelo executa `efetiva_acordo`, devolve vazio → retry roda a tool de novo → acordo duplicado. | Se já houve tool com efeito (`tracker.externalEffect`/tool não-GET), **não** reexecutar o provider; seguir o caminho de fallback que já existe, sem alterar nenhum texto. Retry só quando nenhuma tool rodou. |
| IA-04 | **ALTA** | `convert.ts:61-70` | `marker.test(value)` **sem âncora**: `tk={{secret.DDM_TOKEN}}RESTO` passa como "marcador" na conversão para agente (mesma classe do incidente da migration 145). | Fluxo importado com resíduo é convertido e publicado com credencial parcial em texto. | Ancorar (`^…$`, igual a `findInlineSecrets`), e reaproveitar a função única de detecção. |
| IA-05 | **ALTA** | `src/app/api/flows/import/route.ts:71-170` (v2) | Importação/duplicação grava `config` cru: `tk=<literal>` e qualquer credencial em texto entram no banco. | Fluxo exportado de outra conta/ambiente com token → token fica no banco, no editor e em novo export. | PR-0: `sanitizeImportedSecrets` (TASK25) + recusa 400 se sobrar credencial literal; na v2 também normalizar para `{{cred.X}}` quando houver credencial correspondente. |
| IA-06 | **ALTA** | `validate.ts:1249-1258` (v2) | Token em texto na URL é só **aviso** na ativação. | Ativa fluxo com token em texto. | `findInlineSecrets` → **erro** quando o host é `ddmacordos.com` (marcador próprio); fora dele segue aviso. |
| IA-07 | **ALTA** | `flows/cron/route.ts:129-162` | Corpo do wake não tem `try/catch` por run. O run é "reivindicado" (`status` → `active`, linha 136) **antes** de checar `current_node_key`/`next_node_key` (143-160): em dado inconsistente, faz `continue` deixando o run `active` sem avançar; se `advanceFromNodeKey` lançar, o cron inteiro aborta (500) e os demais runs vencidos ficam para o próximo tick. | Um nó `smart_delay` sem `next_node_key` trava o run até o timeout de 24 h e uma exceção derruba o acordar de todos. | Validar antes de reivindicar; `try/catch` por run com `flow_run_events` `node_error` e encerramento controlado; devolver contadores `failed`. |
| IA-08 | **MÉDIA** | `flows/cron/route.ts:118-122` | `limit(20)` sem `order by wake_at`; backlog >20 por tick acorda em ordem arbitrária e pode atrasar os mais antigos (inanição). | Campanha com muitos `smart_delay` vencendo juntos → atrasos de minutos/horas. | `order('wake_at')`, lote configurável, loop até esvaziar com teto de tempo. |
| IA-09 | **MÉDIA** | `ai-watchdog.ts:70-76` | `limit(50)` das mais antigas **antes** dos filtros em código (heartbeat, resposta, run ativa, tipo de nó). Candidatas que nunca serão tratadas (fila humana esperando) ocupam as 50 vagas; ~4 consultas por candidata (N+1). | Com >50 conversas `open` sem agente mais antigas que a janela, conversas travadas de IA mais novas nunca entram na varredura. | Resolver no banco (RPC/`JOIN`: `flow_runs active` + `flow_nodes.node_type='ai_agent'`), índice de apoio, filtros no SQL. |
| IA-10 | **MÉDIA** | `engine.ts:1497-1503` | `selectAgentForTeam` recursa em `overflow_team_id`; o CHECK da 049 só impede `overflow = id` (`049_teams.sql:60`), **ciclo A→B→A** é possível. | Duas equipes sem atendente com overflow cruzado → recursão infinita (estouro de pilha/timeout) no handoff. | Conjunto de equipes visitadas + profundidade máxima (ex.: 3); validar ciclo no salvar equipe. |
| IA-11 | **MÉDIA** | `engine.ts:2448-2460, 2481` | `tool_called.args` (CPF) e até 8.000 caracteres do corpo bruto da DDM em `flow_run_events`. | Vazamento de PII para quem lê eventos/exports de run. | Mascarar CPF em args (`***.***.***-12`), reduzir `result` ao necessário, mascarar valores de credenciais; (retenção continua fora de escopo). |
| IA-12 | **MÉDIA** | `responder.ts:126,151,1370,1378,1402` | Token da DDM interpolado em URL em 5 pontos do legado; erro/log de rede pode carregar a URL. `fetchDdmCpfDetails` trata `localizaData[0]` sem checar `ERRO`. | `[{"ERRO":…}]` é tratado como devedor sem `iddev` (cai em "missing iddev" silencioso); token em stack/log. | Cliente DDM único (`lib/integrations/ddm.ts`) com classificação IA-01, header/segredo resolvido por `{{cred}}`/env, sem log de URL. |
| IA-13 | **MÉDIA** | `settings/tools/[id]/test/route.ts:58` | Teste de ferramenta devolve `ok: res.ok` e o corpo, sem classificar corpo de erro HTTP 200. | Admin testa a ferramenta com token errado e vê "ok". | Usar `classifyToolBodyFailure` no teste e devolver `failure_code`. |
| IA-14 | **MÉDIA** | `settings/secrets/[id]/route.ts:116-135` | `DELETE` de credencial/variável não verifica uso (ferramentas, agentes, nós, RAG); renomear é proibido (bom). | Apagar `DDM_TOKEN` usado por 3 ferramentas → todas falham como "credencial ausente" → `#INSTABILIDADE` em massa. | Checar uso (`findAccountSecretRefs` já existe) e responder 409 com a lista; `?force=true` só owner (padrão do DELETE de ferramenta). |
| IA-15 | **MÉDIA** | `responder.ts:1081-1085` | KB lida **inteira** (conteúdo de todos os arquivos da conta) a cada turno e filtrada em memória, mesmo com `selection_mode: explicit`; sem `.range()`. A versão do agente guarda só `content_hash` (`service.ts:495-501`) — o conteúdo usado é o **vivo**. | Editar um arquivo da KB muda o comportamento de versões "fixadas" (rollback não restaura conhecimento); custo de leitura alto. | `.in('id', file_ids)` quando explícito; decidir (P2) se a versão fixa conteúdo (snapshot) ou apenas avisa por hash divergente. |
| IA-16 | **MÉDIA** | `scripts/convert-ai-nodes-to-agents.mjs:41,223` | "Run ativo" considera só `active`/`paused_by_agent`; **`delayed`** (smart_delay) fica de fora. | Converte fluxo com run `delayed`; ao acordar, o run não tem snapshot e fixa a versão **publicada naquele momento** (comportamento diferente do nó inline que ele começou). | Incluir `delayed` (e `waiting` se existir — confirmar enum no live) no filtro; conversão por fluxo com "drenagem" documentada. |
| IA-17 | **MÉDIA** | `responder.ts:2330-2418` | Providers Claude/Gemini/Hermes: sem semáforo/429 (`gatedFetch`), sem tools; só OpenAI tem recuperação completa. | Conta configurada com Claude: sem limite de concorrência e sem tools; 429 vira exceção. | Estender `gatedFetch` aos demais; deixar explícito no contrato do agente que tools exigem provider compatível (validar no publish). |
| IA-20 | **BAIXA** | `acordo-trigger.ts:15-46`, `sentiment-trigger.ts` | Timers em memória (Passenger) para sugestão de acordo/sentimento. | Restart perde análise (aceito, best-effort). | Se virar requisito, mover para fila/cron stateless. |
| IA-21 | **BAIXA** | `flows/[id]/simulate/route.ts:104`; `tool-test:29` | Rate limit em memória (por processo) — com N processos o teto efetivo é N×. | Uso acima do esperado do LLM no simulador. | Aceitar ou mover para contador no banco. |
| IA-22 | **BAIXA** | `flows/cron/route.ts:164-166` vs `ai-watchdog.ts:47` | Comentário diz ~90 s; o padrão real é 180 s. | Confusão operacional. | Corrigir comentário/documentar `AI_STALL_SECONDS`. |
| IA-23 | **ALTA** | `responder.ts:766-796` | Opt-out/pessoa errada: `upsert(..., { onConflict: "telefone" })` em `blacklist` — a chave de conflito não inclui `account_id`; se a unicidade for global por telefone, uma conta **sobrescreve a linha de outra** (motivo/`account_id`). **A confirmar no live** (índice único real de `blacklist`; as migrations só mostram índices comuns, `168_…:42-51`). | Mesmo telefone em duas contas: `account_id` da linha troca; a conta original perde o registro de opt-out. | Confirmar o índice; se global, unicidade `(account_id, phone_key)` e `onConflict` correto (alinhado ao PRD 11 / `phone_key`). Opt-out nunca pode regredir. |

---

## 4. Objetivos e não-objetivos

**Objetivos**
1. Nenhuma resposta de erro da integração (qualquer formato conhecido da DDM) chega ao modelo ou aos eventos como sucesso.
2. Nenhuma credencial literal entra no banco por importação/duplicação/conversão; DDM usa marcador, demais domínios, `{{cred.X}}`.
3. Nenhuma ação irreversível repetida por retry do modelo (a regra de negócio sobre acordo por texto está na seção 14).
4. Cron de fluxos e watchdog isolam falhas por run, não passam fome e são observáveis.
5. Fechar as pendências técnicas de agentes (KB por agente com snapshot decidido, RAG, dedupe, conversão segura, rotação de credencial) **sem alterar comportamento de negócio**.
6. Contrato de API do front documentado (seção 8) e estável.

**Não-objetivos**
- Reescrever o engine; mexer em truncagem; mexer em `hasRunLeftNodeSnapshot`; retenção de dados; `limite_por_hora`.
- Qualquer regra de negócio: prompt, textos da IA (inclui fallback "Ben"), personas, encerramento, xingamento, acordo (REGRA DO DONO, 08/10). Aparecem só na seção 14, sem requisito e sem PR.
- RAG vetorial **em produção** (entra como fase condicionada a decisão e bancada; ver 6.5).

---

## 5. Requisitos

### Funcionais (critério de aceite testável)
- **RF-1 Classificação DDM.** Dado `[{"ERRO":{"ERRO":"TOKEN INVALIDO"}}]` → `TOOL_AUTH_ERROR`, `retryable=false`, uma única tentativa, tally conta como indisponibilidade, evento `tool_result` com `status=error`, mensagem à IA sem o texto do provedor. Dado `[{"ERRO":{"ERRO":"Erro ao executar a query: …"}}]` → `TOOL_SERVER_ERROR` retentável (até 3 tentativas nas tools seguras). `[{"nome":"Maria"}]`, `[{"ERRO":""}]`, array com 2 elementos → não é falha. Testes com os payloads reais.
- **RF-2 Importação/duplicação.** `tk=` literal em `ddmacordos.com` (inclusive com `{`/`}` no meio, terminando em `&`/`#`/fim) vira `{{secret.DDM_TOKEN}}`; marcador correto e variável `{{x}}` ficam; marcador com resíduo é corrigido; credencial literal em outro domínio → 400 com explicação **sem repetir o valor**; nada é gravado.
- **RF-3 Ativação.** `findInlineSecrets` em host `ddmacordos.com` bloqueia ativar (severity `error`); outro domínio, aviso.
- **RF-5 Sem retry com efeito.** Se alguma tool não-GET (ou marcada `has_effect`) executou no turno, resposta vazia **não** reexecuta o provider (segue o fallback existente, textos inalterados).
- **RF-6 Cron.** Run `delayed` com dado inconsistente é encerrado/sinalizado sem aborar o lote; contadores `{swept, woken, failed, stalled}` no JSON; ordem por `wake_at`.
- **RF-7 Agentes.** Excluir credencial/ferramenta/arquivo em uso devolve 409 com a lista; conversão ignora fluxos com run `active|paused_by_agent|delayed`.

### Não funcionais
- **Desempenho:** turno de IA (sem tools) p95 ≤ 8 s e (com 1 tool DDM) ≤ 15 s excluindo fila do semáforo; watchdog ≤ 2 s por varredura com 10 mil conversas abertas (consulta única indexada); cron de fluxos ≤ 5 s por tick com 200 runs vencidas.
- **Segurança:** zero segredo em log/evento/export; hosts de credencial validados pela URL final (já existe, manter); admin/owner para escrita de credenciais/ferramentas/agentes (já existe: `guardRole('admin')`), supervisor só leitura/preview.
- **Observabilidade:** ver seção 10.

---

## 6. Desenho proposto

### 6.1 Integração DDM como módulo único (IA-01, IA-12, IA-13)
- `src/lib/integrations/ddm/classify.ts` (puro, sem import de servidor — `validate.ts` roda no navegador): `extractNestedError`, `classifyDdmBody`. `tool-recovery.classifyToolBodyFailure` e `engine.parseToolFailure` usam o mesmo código; teste de contrato com payloads reais.
- `TOOL_AUTH_ERROR` entra em `isIntegrationOutage` (a conversa não fica esperando o modelo decidir). Alternativa descartada: tratar auth como "negócio" (a IA continuaria como se houvesse resposta).
- Cliente DDM do legado (`responder.ts:120-260`, `1363-1419`) passa a usar o classificador e a credencial por marcador; sem `console.log` do corpo.

### 6.2 Segredos na entrada de fluxo (IA-04/05/06)
- `tool-secrets.ts` ganha `sanitizeImportedSecrets` (módulo puro, igual TASK25). Na v2, ordem: (1) `tk=` DDM → `{{secret.DDM_TOKEN}}`; (2) outros hosts com credencial literal → 400. Extensão v2 opcional: se existir credencial `{{cred.X}}` com `allowed_hosts` cobrindo o host, oferecer sugestão no erro.
- Mesma função alimenta `convert.ts` (âncora) e o PUT de fluxo (hoje só validador).

### 6.3 Efeito irreversível não se repete por retry (IA-03)
- `tracker.externalEffect` passa a controlar também o retry de resposta vazia. A regra de negócio sobre acordo por texto (IA-02) não é tratada aqui: ver seção 14.

### 6.4 Cron e watchdog (IA-07/08/09)
- `sweepable_flow_runs` e uma nova RPC `wakeable_flow_runs(p_limit)` (`FOR UPDATE SKIP LOCKED`, ordenada por `wake_at`) reivindicam atomicamente; o corpo do wake vira função `wakeRun(run)` com `try/catch`, que em erro grava `flow_run_events(node_error)` e move o run para estado final controlado.
- Watchdog em RPC única `stalled_ai_conversations(p_stalled_before, p_not_older_than, p_limit)` com `JOIN` (conversa aberta sem agente + `flow_runs.active` + `flow_nodes.node_type='ai_agent'`), sem consultas por candidata. Índice parcial em `flow_runs(status, conversation_id)` e `conversations(status, last_customer_message_at)` onde faltar (**A confirmar no live** com `EXPLAIN`).

### 6.5 Perfis de agente — pendências das fases 1–4
| Pendência | Desenho | Decisão |
|---|---|---|
| **KB por agente** (IA-15) | `.in('id', file_ids)` quando `explicit`; opcionalmente snapshot de conteúdo em `ai_agent_knowledge_snapshots` (hash→texto) para o rollback restaurar conhecimento | P2 |
| **RAG vetorial** | Hoje só RAG externo opcional (flag + `{{cred}}`, política "segue sem RAG"). Vetorial interno = `pgvector` (extensão/compute — **A confirmar**), embeddings por arquivo (`kb_chunks`), `top_k` na seleção; mantém `kb-context` como fallback. Entra só após bancada de custo/qualidade | Fase 3, condicionada |
| **Dedupe** | `deduplicateAgents` (hash `config+composition+prompt`) já existe; falta aplicar no `--apply` por conta e UI de "agentes duplicados" (listar `config_hash` iguais, `ai_agent_versions_hash_idx`) | Fase 2 |
| **Conversão em produção com runs ativos** (IA-16) | Filtro `active|paused_by_agent|delayed`; modo `--drain`: só converte quando `flow_runs` do fluxo está vazio; relatório por fluxo; reversão = limpar `agent_id` (nó volta ao inline, que permanece no config) | Fase 2 |
| **Rotação de credencial com run ativo** | Já seguro: credenciais carregadas **por chamada** (`account-secrets.ts` cabeçalho) — rotação vale no próximo turno. Falta: guarda de uso no DELETE (IA-14), registro de auditoria `credential.rotated` e alerta se o 1º turno após rotação falha (`TOOL_AUTH_ERROR` em `tool_result`) | Fase 1 |
| **Versão fixada × desligar agente** | Desligar vale na hora (regra atual, mantida); documentar no contrato que `enabled=false` derruba runs em andamento para a saída de falha | — |

---

## 7. Dados e migrations

Todas manuais no SQL Editor, `BEGIN/COMMIT`, pré-check, idempotentes; `CREATE INDEX CONCURRENTLY` em arquivo próprio. Próximo número livre: **194+** (a v2 termina em 193).

| # | Conteúdo | Pré-check / rollback |
|---|---|---|
| 194 | `wakeable_flow_runs(p_limit)` (RPC `SECURITY DEFINER`, `FOR UPDATE SKIP LOCKED`, `ORDER BY wake_at`) | `to_regclass('wacrm.flow_runs')`; `DROP FUNCTION` |
| 194b | índice parcial `flow_runs(wake_at) WHERE status='delayed'` (CONCURRENTLY, arquivo próprio) | confirmar com `\d` se já existe; `DROP INDEX` |
| 195 | `stalled_ai_conversations(...)` (RPC) + índices de apoio | `EXPLAIN` no live antes; `DROP FUNCTION` |
| 196 | `ai_agent_knowledge_snapshots` (se P2 = snapshot) | `to_regclass`; `DROP TABLE` (sem dependências) |
| 199 | `blacklist` unicidade por `(account_id, wacrm.phone_key(telefone))` — **só se** o live confirmar índice global por `telefone` (IA-23); coordenar com PRD 11 | consultar `pg_indexes` primeiro |

Não há migration para IA-01/04/05/06 (só código).

---

## 8. Contrato para o frontend (rotas existentes na v2 — documentadas a partir do código)

Autenticação: sessão do usuário. Papéis: `supervisor` = leitura/preview; `admin` (inclui owner) = escrita. Erros: `{ error: string, issues?: [{path,message}] }` com status HTTP; 401/403 pelo guard; 429 do rate limit.

### 8.1 Agentes — `src/app/api/settings/agents/**`
| Método e rota | Papel | Corpo | Resposta |
|---|---|---|---|
| `GET /api/settings/agents` | supervisor | — | lista de agentes (`id,name,enabled,published_version_id,updated_at`, versões e **uso por fluxo/nó** — `loadAgentUsage`, `service.ts:256`) |
| `POST /api/settings/agents` | admin | `{name, config, prompt_content, composition, rules:[{content,enabled}], tool_ids:[uuid], knowledge:{selection_mode,file_ids?}}` | **201** `{agent_id, version_id, version}` (publica a v1) |
| `GET /api/settings/agents/[id]` | supervisor | — | `{agent, versions[], usage[], published{rules,tools,knowledge,config…}}` |
| `PATCH /api/settings/agents/[id]` | admin | `{name?}` e/ou `{enabled?}` (só esses dois campos) | `{agent}`; desligar derruba runs em andamento para a saída de falha |
| `DELETE /api/settings/agents/[id]` | admin | — | `{ok:true}`; **409** se usado em runs/nós ("desligue-o em vez de excluir") |
| `POST /api/settings/agents/[id]/versions` | admin | mesmo corpo do POST | `{agent_id,version_id,version}` (nova versão **publicada**) |
| `POST /api/settings/agents/[id]/rollback` | admin | `{version_id}` (exatamente esse campo) | `{version_id,version}` (cria nova versão a partir da escolhida) |
| `POST /api/settings/agents/preview` | supervisor | corpo de agente | `{system_prompt}` (prompt composto, sem executar) |
Erros: 400 validação (com `issues`), 404, 409 (nome duplicado, em uso), 500 genérico. Credencial literal → 400 "Use {{cred.NOME}}".

### 8.2 Ferramentas — `src/app/api/settings/tools/**`
`GET /tools` (supervisor) · `POST /tools` (admin → **201** `{tool, warnings[]}`; 409 nome duplicado) · `PATCH /tools/[id]` · `DELETE /tools/[id]` (409 `used_by_agents:true` se alguma versão de agente referencia; sem `?force=true` 409 se usada em fluxos; **nem o force passa** para uso por agente) · `POST /tools/[id]/test` (admin, `{arguments?}` → `{ok,status,body}`; rate limit 20/min; **vai ganhar `failure_code`**, IA-13). Nunca devolve valor de credencial.

### 8.3 Variáveis e credenciais — `src/app/api/settings/secrets/**`
`GET /secrets` (supervisor; sem valores de credencial) · `POST /secrets` (admin) · `PATCH /secrets/[id]` (nome e tipo imutáveis; credencial: `value`/`allowed_hosts`) · `DELETE /secrets/[id]` (admin; **vai devolver 409 com `used_by[]`**, IA-14).

### 8.4 Fluxos — `src/app/api/flows/**`
`GET/POST /flows`; `GET/PUT/DELETE /flows/[id]`; `POST /flows/[id]/activate` (**422** `{error, issues}` quando há `severity:"error"`, agora incluindo token DDM em texto); `GET /flows/[id]/export`; `POST /flows/import` (`{version:"1.0", mode?:"import"|"duplicate", flow, nodes}` → **201** `{flow_id}`; **400** com explicação quando há credencial literal); `GET/DELETE /flows/[id]/runs`; `GET /flows/templates`; `POST /flows/end-run`; `POST|GET /flows/cron` (segredo, não é do front).

### 8.5 Simulador — `POST /api/flows/[id]/simulate`
Supervisor+. Entrada via `parseSimulateRequest` (rascunho de nós + estado + mensagem do "cliente"; limite de corpo `SIM_MAX_BODY_CHARS`, 413 se maior). Saída: resultado do turno + `remaining` (mensagens restantes) e `real_read_denied` quando supervisor pede leitura real. 429 + `Retry-After` ao exceder 30 mensagens/10 min. Falha de agente publicado vira "indisponível" (mesma regra do runtime).

### 8.6 Outros
`GET /api/conversations/[id]/suggest-tag` (sugestão de tabulação; `source`: `exit_tag`|`llm`; "incerto" é válido) · `POST /api/ai/prompt-versions` (histórico de prompt).

### 8.7 Novos contratos previstos neste PRD
- `DELETE /secrets/[id]` e `DELETE /tools/[id]`: corpo de erro 409 `{error, used_by:[{type:"tool"|"agent"|"flow_node", id, name}]}`.
- `POST /flows/import`: 400 `{error, rejected:[{node_key, param}]}` (sem valores).
- `GET /api/flows/[id]/runs` ganha `events[].status="error"` e `failure_code` nos `tool_result`.

---

## 9. Testes e aceite
- **Unit:** payloads reais DDM (`TOKEN INVALIDO`, `Erro ao executar a query`) em `tool-recovery.test.ts`; `sanitizeImportedSecrets` (token com `{`/`}`, `&`, `#`, fim, marcador correto, resíduo, outro domínio); `convert.ts` com resíduo; retry com `externalEffect`.
- **PGlite:** `wakeable_flow_runs` (SKIP LOCKED, ordem, concorrência de 2 cron), `stalled_ai_conversations` (resultado igual ao laço atual em massa de teste), idempotência de `ddm_formalizations`.
- **Cron/engine:** run `delayed` com dado inconsistente não aborta o lote; ciclo de overflow termina.
- **Staging/bancada:** fluxo real da DDM com token inválido (esperar `#INSTABILIDADE`/handoff e evento `error`); rotação de credencial com run ativo; conversão `--apply` em cópia do banco.
- **Aceite "blindado":** RF-1..RF-7 verdes + varredura de imports (`validate.ts` não importa código de servidor) + `tsc` limpo + 0 ocorrências de `tk=${` em `src/` (grep no CI).

---

## 10. Observabilidade
- Eventos: `tool_result.status=error` com `failure_code` (inclui `TOOL_AUTH_ERROR`); contadores do cron `{swept,woken,failed,stalled}` em `writeLog`.
- Métricas/alertas (via log estruturado `source:"flows"`/`"ai"`): taxa de `TOOL_AUTH_ERROR` por conta (alerta ≥1 em 5 min — token quebrado), `ai_response_stalled` por hora, 429 do LLM por minuto, fila do semáforo (`llmGateStats`), runs `delayed` vencidas há >10 min, `agent_unavailable`/`agent_disabled` por agente.
- Não registrar: valores de credencial, corpo bruto da DDM, CPF completo.

---

## 11. Riscos, rollback e plano de implantação
- Flags: `AI_DDM_STRICT_ERRORS` (liga IA-01; padrão ligado após bancada), `FLOWS_CRON_V2` (novo caminho de wake).
- Ordem: PR-0 (portar TASK25) → PR-1 (efeitos) → PR-2 (cron/watchdog) → demais. Cada PR reversível por flag/`git revert`; migrations 194+ têm `DROP` documentado.
- Risco IA-01: classificar mais respostas como falha pode aumentar `#INSTABILIDADE`/handoffs; mitigar com shadow-log por 48 h na bancada antes de ligar em produção.
- Passenger: nada novo em memória; timers existentes (acordo/sentimento/debounce fallback) permanecem best-effort e documentados.

---

## 12. Fases e PRs (todos pequenos; base `v2`)

| PR | Escopo | Dep. | Tam. |
|---|---|---|---|
| PR-0 | **Portar TASK25 para a v2** (classificador `ERRO`, `TOOL_AUTH_ERROR`, `sanitizeImportedSecrets`, `findInlineSecrets`→erro DDM, comentário migration 145) adaptando aos marcadores `{{cred}}` da v2; `parseToolFailure` unificado | main→v2 | P |
| PR-1 | Efeitos seguros: retry vazio respeita `externalEffect`; sem `console.log` de corpo da DDM | PR-0 | M |
| PR-2 | `convert.ts` âncora (IA-04) + DELETE de credencial/ferramenta com uso (IA-14) + teste de ferramenta com classificador (IA-13) | PR-0 | P |
| PR-3 | Cron de fluxos: `try/catch` por run, ordem, validação pré-claim; migration 194/194b | — | M |
| PR-4 | Watchdog em RPC única (195) + índices | PR-3 | M |
| PR-5 | `selectAgentForTeam` com anti-ciclo; validação no salvar equipe | — | P |
| PR-6 | Máscara de PII nos eventos (IA-11) | — | P |
| PR-7 | KB: `.in(file_ids)` + decisão de snapshot (196 se aprovado) | P2 | M |
| PR-8 | Conversão em produção: filtro `delayed`, `--drain`, relatório, dedupe por conta | PR-0 | M |
| PR-9 | Providers Claude/Gemini/Hermes com `gatedFetch` | — | M |
| PR-12 | RAG vetorial (pgvector) — bancada de custo/qualidade antes de qualquer produção | P3 | G |
| PR-13 | `blacklist` unicidade (199), **só se** live confirmar IA-23 | PRD 11 | P |

---

## 13. Perguntas ao dono
1. **Credencial literal na importação em outro domínio:** recusar (proposto) ou importar e exigir correção na ativação?
2. **Versão de agente × KB:** a versão deve fixar o **conteúdo** dos arquivos (rollback restaura conhecimento, custa armazenamento) ou apenas o hash (avisa quando divergir)?
3. **RAG vetorial:** vale o custo (pgvector/compute/embeddings) agora, ou seguimos com KB com teto de caracteres + RAG externo opcional?
4. **Providers:** Claude/Gemini/Hermes continuam suportados sem tools, ou restringimos agentes com tools a OpenAI?
5. **A confirmar no live (peço aval para consultar):** índice único real de `blacklist`; valores aceitos no CHECK de `ai_decisions.decision_type`; enum de `flow_runs.status` (existe `waiting`?); `EXPLAIN` das consultas do watchdog; extensão `pgvector` disponível no plano Supabase.

---

## 14. Decisões da operação (fora do escopo técnico)

REGRA DO DONO (08/10): prompt, textos da IA (inclui o fallback "Ben"), personas, quando encerrar conversa, como tratar ofensa e quando/como propor ou efetivar acordo **não são escopo técnico**. Os itens abaixo ficam só como decisão da operação: o risco técnico é descrito para quem decide, **sem requisito de mudança de comportamento, sem PR, sem flag e sem migration neste PRD**. O comportamento atual de produção permanece como está.

### D-1 Formalização de acordo por texto livre do modelo (antes IA-02, crítico)
- **Onde:** `responder.ts:1318-1331` (frases como "confirmar os dados", "boleto oficial" marcam `hasAgreedAcordo`), `1363-1419` (chamada à DDM `CalculaDebitos.php` sem `override` do nó).
- **Risco técnico:** o efeito na DDM (formalizar acordo) é disparado por heurística de texto, não por tag/tool explícita; um falso positivo do modelo formaliza acordo sem decisão do cliente; não há idempotência por `conversation_id`+`calculoId`, então repetição de turno pode duplicar. O token vai literal na URL em 5 pontos e o corpo da DDM é impresso por `console.log` (`:1406`) — **esses dois pontos são técnicos e continuam cobertos por IA-12 e PR-1 (sem log do corpo, token por marcador)**, sem alterar quando o acordo é formalizado.
- **Quem decide:** operação/dono — manter o atalho por frases, exigir tag/tool explícita, ou restringir por conta; e se existe fluxo em produção que depende dele.

### D-2 Texto de fallback fixo com a persona "Ben" (antes IA-18)
- **Onde:** `responder.ts:89-90, 1294`.
- **Risco técnico:** o fallback é o mesmo para qualquer agente/persona; um agente com outro nome pode enviar mensagem com identidade que não é a dele.
- **Quem decide:** operação — se o texto deve variar por agente, qual o texto neutro e quem o aprova.

### D-3 Comportamento acoplado ao nó `agente_de_ia` (antes IA-19)
- **Onde:** `responder.ts:2050` e `engine.ts:2114` (`isBenAiAgentNode`: suprime texto se `nominal > 0`).
- **Risco técnico:** a regra depende do `node_key`; renomear o nó a desliga e outro fluxo com o mesmo nome a herda. `legacy_ben_auto_exit` já existe no config do agente convertido (`convert.ts`).
- **Quem decide:** operação — se essa regra de saída continua como está, vira configuração do agente ou deixa de existir.

### D-4 Encerramento automático da conversa pela IA (antes pergunta 1)
- **Onde:** `outcome-suggestion.ts:16,102` (cabeçalho registra "decisão de produto pendente"), `ai_exit_tag_outcome_map.auto_close`.
- **Risco técnico:** hoje só fecha com `auto_close=true` na linha do mapa e conversa sem tabulação (padrão `false`); não há trilha de auditoria da decisão automática nem como medir "teria fechado" antes de ligar.
- **Quem decide:** operação — condições de fechamento (tags, confiança), efeito no run e se/quando ligar por conta.

### D-5 Cliente que xinga (antes pergunta 2)
- **Onde:** `abuse-guard.ts:28-49` (lista de termos), `responder.ts:807-843`.
- **Risco técnico:** handoff imediato, sem aviso; a lista é constante no código (mudar exige deploy); quando a mensagem é também intenção prioritária (ex.: contestação), a trava de ofensa não roda (`responder.ts:807`).
- **Quem decide:** operação — manter handoff imediato, aviso antes, termos e precedência sobre contestação.

### D-6 Texto de resposta vazia / fallback da IA (antes pergunta 8)
- Mesmo tema de D-2: texto e aprovação são da operação. O tratamento técnico de **não reexecutar tools com efeito** no retry vazio (IA-03/RF-5) continua no escopo e não altera nenhum texto.
