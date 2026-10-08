# 20 — Organizações, papéis e permissões personalizadas (V2 backend)

> Base: branch `v2` (`origin/v2` @ `3151b60`, 08/10/2026), worktree `wt-codex`. Revisão **somente leitura** (nada executado; sem acesso ao banco live). Estado do banco reconstruído **aplicando as migrations 001..193 em ordem** (a última definição vale); o que só o ambiente real responde está em **"A confirmar no live"** com a SQL exata (Anexo A). Linhas conferidas no código/migrations atuais.
> Regras: **só V2** (toda branch parte de `origin/v2`, todo PR tem base `v2`) · **não mexer em negócio** (prompt, textos da IA, quando encerrar/handoff, acordo, cobrança → só "Decisão da operação", 4.1) · plataforma self-service (PRD 19) · Meta×WAHA nunca unificados · migrations manuais, idempotentes, com pré-check, `CREATE INDEX CONCURRENTLY` em arquivo próprio · retenção fora do escopo · migrations deste PRD: faixa **240–249**.
> Relacionado: PRD 14 (RLS/grants, segredos, auditoria de segurança — itens de papel citados aqui), PRD 19 (cofre por conta e config por conta usam as permissões definidas aqui), PRD 15 (CI/testes).

## 1. Resumo

- **Pedido do dono (08/10):** dados separados por **organização**; cada usuário só acessa a organização em que foi cadastrado; papéis **proprietário → admin → supervisor → operador**; **acesso personalizado com permissões personalizadas, só o proprietário cria**.
- **Achado central:** a organização **já existe** (`wacrm.accounts` + `account_id` + RLS) e hoje **1 usuário = 1 organização** (`profiles.account_id` + `profiles.account_role`, migration 017) — bate com o pedido. O que **falta** é o papel personalizado: o papel é uma **escada fixa** (`owner 5 … viewer 1`, enum `account_role_enum`) espalhada por **~150 policies de RLS, ~160 predicados em TypeScript, 15+ checagens por string fora dos helpers e 41 telas que escrevem direto do navegador**. Papel personalizado não cabe nessa escada.
- **Proposta:** um **catálogo fechado de permissões** (~60 chaves, com escopo conta/equipe/próprio), **papéis como linhas de banco** (5 de sistema semeados com **comportamento idêntico ao de hoje** + personalizados por organização), uma função única **`can(ctx, perm)`** no servidor e **`has_perm(perm)`** em SQL (1 org por usuário → sem N+1, cache por statement). **Fase 1 não muda comportamento**; fase 2 libera o personalizado, com teto (nunca passa do admin; chaves "só proprietário" nunca entram) e só o proprietário cria, edita e atribui.
- **Dívida de segurança descoberta no caminho** (corrige-se junto, pois o modelo novo depende disso): admin rebaixa/remove outro admin (P-02), "remover membro" não revoga acesso (P-03), `bulk-invite` cria vários owners (P-04), RLS por papel diverge da UI (P-05/06/07), sem auditoria de convites/papéis (P-09).
- **Fora do escopo (registrado):** um usuário em várias organizações (custo na seção 6.10).

## 2. Estado atual

### 2.1 Organização e vínculo

| Fato | Evidência |
|---|---|
| Organização = `wacrm.accounts` (`id`, `name`, `owner_user_id` NOT NULL FK `auth.users` ON DELETE RESTRICT); **`idx_accounts_one_per_owner` = UNIQUE(`owner_user_id`)** | `017_account_sharing.sql:60-80` (+ `:73`) |
| Não existe tabela de memberships: vínculo = `profiles.account_id` (NOT NULL) + `profiles.account_role` (enum NOT NULL); `profiles.user_id` UNIQUE ⇒ **1 usuário, 1 organização** | `017:71-72,112-114,121-122,274-275`; `001:22` |
| Enum `account_role_enum`: `owner, admin, supervisor, agent, viewer` (017 cria 4; 139 adiciona `supervisor` antes de `agent`); ranking em `is_account_member`: 5,4,3,2,1; valor fora da lista → `NULL` | `017:50-55`; `139:11-27`; `140:66-79` |
| `agent` = "operador"; `viewer` é extra (só `/dashboard` e `/seguranca`) | `role-utils.ts:56-90`; `papeis-codigo` §e |
| Todo signup cria uma conta nova + profile `owner` (`handle_new_user`; engole exceção: falha silenciosa deixa usuário sem profile) | `017:659-682` |
| Trava de colunas privilegiadas de `profiles` (`user_id/account_id/account_role`) para `anon/authenticated` | `169:33-98` |
| **Nada impede 0 ou >1 profiles `owner` por conta** (`accounts.owner_user_id` é só ponteiro desnormalizado) | `017:73`; `bulk-invite/route.ts` (aceita `owner`/`administrador`) |
| O dono acredita que produção tem **2 organizações**: **A confirmar no live** (Anexo A-2/A-3) | — |

### 2.2 Onde o papel é checado (mapa)

**Helpers TypeScript.** Fonte do papel: `profiles.account_role` lido em `getCurrentAccount()` (`src/lib/auth/account.ts:117-135`; devolve **403** para qualquer valor fora do enum via `isAccountRole`, `:133`) e no navegador por `use-auth.tsx:163,222,418-431`. Escala plana `hasMinRole` (`roles.ts`), `requireRole`/`guardRole` (`account.ts:180-189`, `route-guard.ts`), `guardFlowAccess` (`lib/flows/route-auth.ts:12-35`), `requireDisparadorAccess` (`lib/disparador/route-auth.ts:14-28`, deriva do `ROUTE_ALLOWLIST`), `resolveIntelligenceScope` (`lib/intelligence/scope.ts:25-59`), chaves de API por escopo (`api-context.ts:96-130`, `scopes.ts`).

**Gate de página:** `ROUTE_ALLOWLIST` por prefixo (`role-utils.ts:60-98`), aplicado **só no cliente** (`dashboard-shell.tsx:42-55`); o `middleware.ts` só confere o cookie (`:84-119`) e `protectedPaths` nem lista `/inbox`, `/equipes`, `/templates` etc. (`:~140-153`).

**Servidor — papel mínimo por domínio (146 rotas; tabela completa nas notas de revisão):**

| Domínio | Mínimo hoje | Observação |
|---|---|---|
| Conta, membros, convites, transferência | admin (reset de senha e bulk-invite: owner; transferência: owner) | `account/members/[userId]:54,139`; `reset-password:35`; `bulk-invite:128`; `transfer-ownership:60` |
| Chaves de API | admin; supervisor só chave pessoal `intelligence:read` | `api-keys/route.ts:82-90`; `personal.ts:50-79` |
| Canais/WhatsApp/templates/webchat | admin (POST `whatsapp/config` admin; **GET/DELETE/PATCH sem papel**) | **G1** `whatsapp/config/route.ts:82,936,997` |
| Inbox (enviar/transferir/encerrar/IA) | agent | `whatsapp/send:39`, `transfer:35`, `close:31`, `sentiment:12` |
| Disparador (campanhas, limites, erros, UTM) | owner/admin (`canManageCampaigns`) | exceções sem papel: `campaigns/[id]/info:24` e `audience:22` (**G2**) |
| Fluxos | admin (`guardFlow`); simulador supervisor; **`flows/end-run` só sessão** (**G3**) | `flows/route-auth.ts:12`; `simulate:70`; `end-run:14-48` |
| Automações | leitura agent / escrita admin | `automations:14,30` |
| IA (`ai-config`), agentes, tools, segredos | admin escreve; supervisor lê (agentes/tools/segredos mascarados) | `ai-config:59`; `settings/*` |
| Intelligence/MCP | owner/admin (conta) ou supervisor (equipes) | `scope.ts:30-59`; `api-key.ts:56-70` |
| Monitoramento, relatórios, exportações | supervisor (escopo equipe por RLS); exportar supervisor, apagar admin | `monitoramento/*`; `relatorios/exports:53,151` |
| API pública v1 | escopo da chave, **conta toda** | `reporting.ts` |

**Frontend (esconde/mostra):** `sidebar.tsx:78-109,299-334`, `header.tsx:94,107`, `nav.ts`, `report-tabs.tsx`, `settings-sections.ts:57-106`, `<RequireRole>` (`require-role.tsx:35-44`), `useCan(...)` (`use-can.ts:42-62`: `manage-members`, `edit-settings`, `send-messages`, `view-only`, `delete-account`, `transfer-ownership`, `view-conversation-flows`) e comparações por string (`equipes/[id]:324,582-588`, `message-thread:1593`…). **41 arquivos escrevem direto do navegador** (`.insert/.update/.delete/.upsert`): para eles a **única** proteção é a RLS.

**RLS por papel (definição vigente; nunca por `viewer` > `agent` na escrita):**
- Escrita **agent+**: contatos/notas/tags de contato (`017:387-410,491,502`; `087`), deals, conversas/mensagens (`017:415-416,514,584`), broadcasts, **automations** (`017:457,548`), **flows** (`017:473,559`), **campanhas/blacklist/fila/métricas do disparador** (`085:154-189`), `disparador_message_templates` (`042:38-42`).
- Escrita **admin+**: tags, custom_fields, templates, template_folders, pipelines/stages, **whatsapp_config** (`017:422-424`; `153` limita UPDATE a 5 colunas), teams, quick_replies, clients, deal_aging_rules, mapa de tabulação IA, `api_keys`, `accounts` UPDATE, `account_invitations` (FOR ALL), DELETE de conversa.
- Literais `('owner','admin')`/`='agent'` **fora** de `is_account_member`: `team_members` (`062:26,37`), `team_allowed_templates` (`106`), `team_outcome_tags` (`107`), `audit_logs` SELECT (`131:60-69`), `intelligence_tool_calls` (`141:43-52`) — não enxergam `supervisor` nem papéis novos.
- Visibilidade: `conversations_select` (`140:123-158`: owner/admin/**viewer** = conta inteira; agent = atribuídas a ele + fila da equipe; supervisor = equipes dele) e `whatsapp_config_select` (`140:162-169`).
- **Sem papel mínimo (qualquer membro lê/escreve):** `ai_config` FOR ALL (`031:19-21`; R-1 do PRD 14), `whatsapp_test_sends` INSERT (`074:60`), `disparador_utm_links` (`170:99-103`), `export_history`/Storage de exportações (`055:48-83`), RPCs de relatório (`051:93`, `053:75`, `054:61`, `165:33`), `api_keys` SELECT inclui `key_hash` (`026:68`).

**Funções SQL de membro/papel:** `is_account_member(account, min_role)` (DEFINER, `search_path=''` após a 140), `current_user_role()`, `current_user_team_ids()`, `current_account_id()`, `report_sees_*` (143; só restringe supervisor), `set_member_role`, `remove_account_member`, `transfer_account_ownership` (018), `set_member_team` (049), `set_member_max_simultaneous_chats` (116), `redeem_invitation` (048), `peek_invitation` (019), `handle_new_user` (017). Aviso de **drift**: as migrations 017–019 criam objetos em `public`; o live veio de `all_migrations.sql` (qualificado em `wacrm`) — conferir cópias em `public` (Anexo A-8).

**Convites:** `account_invitations(token_hash UNIQUE, role CHECK (role <> 'owner'), expires_at, accepted_at…)`, sem e-mail (convite não nominal), TTL até 365 dias; criação `requireRole("admin")` + rate limit; resgate por RPC com `FOR UPDATE`; `redeem-by-code` tem UI mas **nenhuma rota gera código**.

**Auditoria:** `trg_audit_profiles` (`131:513-514`: `full_name, account_role, max_simultaneous_chats`), `team_members`, teams/tags/templates/canais/campanhas/flows/automations; `logAuditEvent` só em contatos e disparador. **Nenhuma** rota de `account/**` ou `invitations/**` audita; sem trigger em `accounts`, `account_invitations`, `api_keys`, `ai_config`, `account_secrets`.

## 3. Problemas e riscos

IDs: **G** = lacuna de código (revisão do mapa TypeScript); **P** = lacuna de banco/fluxos (revisão do banco). Mantidos para rastreio.

| ID | Sev. | Onde (arquivo:linha) | Problema | Cenário de falha | Correção |
|---|---|---|---|---|---|
| P-02 | **ALTA** | `018:67-102,156-183` | `set_member_role`/`remove_account_member` só protegem o **owner**; não comparam rank: **admin rebaixa ou remove outro admin** | Dois admins disputam; um admin tira o outro da organização | Regra de hierarquia (6.5): só age sobre rank **menor** que o seu; owner exceção |
| P-03 | **ALTA** | `018:185-199`; `members/[userId]/route.ts` (DELETE) | "Remover" cria uma conta pessoal `owner` e **mantém o login ativo**; não limpa `team_members`, `profiles.team_id`, `max_simultaneous_chats` nem conversas atribuídas | Ex-funcionário continua autenticado e dono de uma conta; some da conta original sem rastro de auditoria (P-09) | "Desativar membro": revogar sessões, limpar equipe/atribuição, estado `disabled`, auditoria (6.6). O destino das conversas abertas = **Decisão da operação** |
| P-04 | **ALTA** | `members/bulk-invite/route.ts` (ROLE_ALIASES, UPDATE do profile) | Cria **vários profiles `owner`** sem alinhar `accounts.owner_user_id`; extras não são rebaixáveis nem removíveis (`018:95,180`); senha única (mín. 6); delete da conta órfã sem checar erro quebra `transfer` futuro | Conta com 3 "donos"; `transfer` falha por `idx_accounts_one_per_owner` | **1 owner por organização** (índice parcial); bulk sem owner; RPC transacional; senha por usuário |
| P-01 | **ALTA** | `031:19-21` | `ai_config` `FOR ALL` por qualquer membro (viewer escreve prompt/chave) | viewer injeta prompt / lê chave | **PRD 14 R-1** (migration 200); aqui só a permissão `ai.config` |
| P-05 | MÉDIA | `051:93,178,257`; `053:75`; `054:61`; `165:33`; `055:48-83,119`; `143:21-56` | RPCs de relatório e export só exigem **ser membro**: agent/viewer chamam direto e veem a conta toda | Operador baixa exportação que a tela não oferece | `reports.*` por permissão; `has_perm` nas RPCs e na policy do Storage |
| P-06 | MÉDIA | `140:127,165` | **`viewer` vê mais que `agent`**: conta inteira de conversas e todas as linhas de canal (agent é filtrado) | Inversão de hierarquia | Decisão do dono (pergunta 13.10); modelo expressa como `conversations.scope_*` |
| P-07 | MÉDIA | `017:457,473`; `085:154-189`; `role-utils.ts:56-90` | **agent+ escreve flows, automations, campanhas, blacklist e `disp_message_queue` por PostgREST** (inclusive enfileirar envio em massa); a UI só dá `/inbox` ao agent | Operador mexe em campanha pelo console | Alinhar a RLS ao mapa de capacidades (admin+/permissão) |
| P-08 | MÉDIA | `062:26,37`; `106:31,42`; `107:30,40`; `131:67`; `141:51`; `063/103/117/128` | Literais `('owner','admin')`/`='agent'` fora de `is_account_member` | Supervisor e papéis novos ficam de fora; reescrita obrigatória | Centralizar em `has_perm()` |
| P-09 | MÉDIA | `src/app/api/account/**`; `131:513` | Sem auditoria de convites, transferência, reset de senha, bulk-invite, api keys, conta; evento de remoção cai na **conta errada** (trigger usa `NEW.account_id`) | Não há como provar quem promoveu/removeu quem | Triggers + `logAuditEvent` + eventos de papel (6.8) |
| P-10 | MÉDIA | `048:131-144,166` | `redeem_invitation`: `v_has_data` ignora campaigns/teams/ai_config…; `DELETE FROM accounts` faz CASCADE → perda silenciosa | Usuário que só tinha campanhas perde tudo ao aceitar convite | Mover vínculo sem apagar (ou checar todas as FKs) |
| P-11 | MÉDIA | `invitations.ts:141`; `redeem-invite-code-card.tsx`; `017:639-641` | `redeem-by-code` sem gerador; se ligado, 39,6 bits legíveis por admin (`token_hash` no SELECT) | Brute force offline | Remover UI/rota ou código com pepper; esconder `token_hash` |
| P-12 | BAIXA | `017:639-641`; `invitations/route.ts` | Convite não nominal; TTL até 365 d; `account_invitations_modify` FOR ALL (admin edita `role/expires_at/accepted_at`); base URL pelo `Host` | Link de convite vazado = acesso | Convite nominal opcional, TTL máx. 30 d, restringir colunas |
| P-13 | BAIXA | `018:253-277` | `transfer_account_ownership` aceita alvo `viewer`; sem confirmação/auditoria | Propriedade vai para um somente-leitura | Alvo ≥ admin + reautenticação + auditoria |
| P-14 | BAIXA | `reset-password/route.ts` | Troca senha por service role sem auditoria nem revogar sessões; política 8 × 6 | — | Auditar, `signOut` global, política única |
| P-16 | BAIXA | `017:659-682` | `handle_new_user` engole exceção | Usuário sem profile → 403 permanente | Alertar e checagem periódica (Anexo A-4) |
| P-17 | BAIXA | `049:118-172` × `062/140` | Dois modelos de equipe: `profiles.team_id` × `team_members` | Visibilidade e atribuição divergem | Unificar em `team_members` |
| P-19 | BAIXA | `017-019` × `all_migrations.sql` | Drift `public` × `wacrm` | Funções duplicadas/órfãs | Reconciliar antes de mexer em papel |
| G1 | **ALTA** | `whatsapp/config/route.ts:82,936,997` | GET/DELETE/PATCH **sem papel** (só sessão + RLS); POST exige admin (`:367`) | Se a RLS do live permitir agent, qualquer papel apaga/edita canal | `can(channels.manage)` em todos os métodos; **confirmar RLS no live** |
| G2 | MÉDIA | `disparador/campaigns/[id]/info:24`; `audience:22` | Só sessão com service role: viewer/agent leem campanha, saúde dos canais (decifra token e chama a Meta) e audiência | Vazamento de contatos e custo na Graph API | `requireDisparadorAccess` → `can(campaigns.manage)` |
| G3 | MÉDIA | `flows/end-run/route.ts:14-48` | Só sessão com service role; encerra execução de fluxo de qualquer conversa da conta | Viewer derruba fluxos | `can(inbox.reply)` + visibilidade da conversa pela RLS |
| G4 | MÉDIA | `role-utils.ts:60-98`; `dashboard-shell.tsx:42`; `middleware.ts:84-119` | Gate de página só no cliente; ~41 arquivos escrevem direto — proteção real = RLS | Permissão personalizada sem RLS equivalente é só cosmética | `has_perm` na RLS (6.4) |
| G5–G8 | MÉDIA | `settings/page.tsx:41`×`ai-config:59`; `equipes/[id]:324`×`teams/.../members:85,159`; páginas owner × APIs admin; simulador/agentes/tools/segredos supervisor sem tela | **Front e API discordam para a mesma capacidade** (IA: tela só owner, API admin; equipes; canais/contatos/pipelines; supervisor sem tela) | Capacidade "existe" para quem não a vê, ou some para quem poderia | Cada capacidade = **uma** permissão usada por tela e API |
| G9 | MÉDIA | `rate-limits-service.ts:39-40,237,243,307,378,428`; `red-quality-gate.ts:31`; `campaigns/[id]/start:83-111`, `stop:27-60`; `api-keys:86-88`; `lines:30`; `calls:15`; `scope.ts:30-33`; `simulate:66-70` | **15+ checagens por string** fora de `guardRole/requireRole` (algumas relêem `profiles`) | Cada uma é um ponto que papel personalizado quebra | Todas viram `can()` |
| G10 | MÉDIA | `engine.ts:1476,1580`; `message-thread:307`; `conversation-list:146`; `monitoramento:665`; `node-config-form:1564`; `team-form-dialog:155`; `equipes/[id]:582-588`; `internal-chat-dialog:295,320` | "Operador" = `account_role='agent'` **fixo** (atribuição, handoff, listas); `equipes/[id]` usa "admin" no sentido de supervisor da equipe | Papel personalizado de atendimento não recebe conversa | Permissão `inbox.receive_assignments` (mecanismo; **quando** fazer handoff = operação, 4.1) |
| G11–G13 | BAIXA | `api-keys:54`; `api-keys:82-110`+`scopes.ts`; `v1/reports/*` | Qualquer papel lista chaves; admin cria chave com **qualquer escopo** independente das próprias permissões; relatórios v1 sempre da conta toda | Chave amplia poder de quem a cria | Escopo ⊆ permissões do criador; `reports:read_team` (6.7) |
| G14–G17 | BAIXA | `middleware.ts:~140-153`; `/automations`, `/historico`, `/lead-extractor` fora do allowlist; `canSuperviseTeams` sem uso; `invite-member-dialog:50` oferece `owner` | Páginas abertas a qualquer papel; `protectedPaths` incompleto; código morto; seletor com opção inválida | Viewer abre `/automations` | Permissões de página no catálogo; limpar |

**Totais:** ALTA 5 (P-01 [PRD 14], P-02, P-03, P-04, G1), MÉDIA 14, BAIXA 12. **P-02/P-03/P-04 são pré-requisito de qualquer papel personalizado** (sem hierarquia e sem dono único, o teto não vale).

## 4. Objetivos e não-objetivos

**Objetivos**
1. Organização como fronteira de dados e de configuração (já é): manter 1 usuário = 1 organização e **provar** isolamento (teste de RLS por organização).
2. Papéis de sistema (proprietário, admin, supervisor, operador, + visualizador) e **papéis personalizados** por organização, com permissões de um **catálogo fechado**, criados/editados/atribuídos **só pelo proprietário**.
3. Uma **única** fonte de autorização: `can(ctx, perm)` no servidor, `has_perm(perm)` na RLS, `GET /me/permissions` para o front — front e API passam a usar **a mesma permissão** por capacidade.
4. **Migração sem downtime e sem mudança de comportamento na fase 1**: papéis fixos viram conjuntos de permissões equivalentes (provado por matriz dourada).
5. Regras de borda: 1 proprietário por organização, hierarquia de gestão de membros, desativação segura, convite com papel, auditoria completa.
6. Fechar as lacunas de autorização (G1–G3, P-02/03/04/05/07/09) como parte do trabalho.

**Não-objetivos:** um usuário em várias organizações (6.10); permissões por **registro** (ex.: "só a campanha X") ou por horário; papéis personalizados com poder acima do admin; alterar regras de negócio (4.1); frontend (só contrato, seção 8); retenção.

### 4.1 Decisão da operação (REGRA DO DONO, 08/10) — sem requisito nem PR

| Item (negócio) | Risco técnico observado (e só isso) | Onde |
|---|---|---|
| **O que cada papel pode fazer** (a matriz de permissões padrão de supervisor/operador/viewer) | O PRD **preserva a matriz de hoje** (fase 1); mudar quem pode o quê é política da operação, decidida pelo proprietário depois, via papéis personalizados | 6.2 |
| Destino das **conversas abertas** de um membro desativado (reatribuir, devolver à fila, encerrar) | Hoje a remoção deixa `team_members`/atribuições sujos (P-03). O PRD entrega o **mecanismo** (desativar + liberar vínculos); a **regra de destino** é da operação | `018:185-199` |
| **Quando** o handoff automático atribui a um operador, e **quem** pode ser alvo | Hoje fixo em `account_role='agent'` (`engine.ts:1476,1580`). O PRD só troca o literal por uma permissão com o **mesmo comportamento** para os papéis de hoje | G10 |
| Viewer ver mais conversas que o operador (P-06) | Inconsistência de hierarquia; **corrigir muda o que o viewer enxerga** → decisão do dono | `140:127,165` |

## 5. Requisitos (com critério de aceite)

### 5.1 Funcionais

| ID | Requisito | Aceite (testável) |
|---|---|---|
| RF-01 | Catálogo fechado de permissões em código **e** em tabela (`permission_catalog`), com escopo (`account`/`team`/`own`), `owner_only` e `grantable`; chaves desconhecidas são rejeitadas | Teste: criar papel com chave fora do catálogo → 422; migration semeia o mesmo catálogo do código (teste de igualdade) |
| RF-02 | Papéis de sistema (owner, admin, supervisor, agent/operador, viewer) são linhas semeadas com conjuntos **equivalentes ao comportamento de hoje**; imutáveis e não apagáveis | **Matriz dourada**: para cada (papel × rota/policy) o resultado novo = o antigo (seção 9) |
| RF-03 | Papel personalizado por organização: nome, descrição, conjunto de permissões ⊆ catálogo `grantable`, **teto = admin** (nunca `owner_only`), dependências validadas | Testes: `ownership.transfer`/`roles.manage` → 422 `owner_only`; permissão sem dependência → 422 `missing_dependency` |
| RF-04 | **Só o proprietário** cria, edita, duplica, apaga e **atribui** papéis personalizados (permissão `roles.manage`, `owner_only`); admin recebe 403 | Teste de rota por papel; teste SQL das RPCs |
| RF-05 | `can(ctx, perm)` único no servidor; **nenhum** `hasMinRole`/literal de papel em rota nova; checagens antigas migradas por domínio | Lint/teste de grep: sem `account_role ===`/`hasMinRole(` em `src/app/api/**` ao fim da fase 3 |
| RF-06 | `has_perm(perm)` em SQL (1 org por usuário, `STABLE`, `search_path=''`) e `is_account_member` mantida por compatibilidade | PGlite: equivalência para os 5 papéis em todas as policies portadas |
| RF-07 | Efeito **imediato** de mudança de papel/permissão (sem relogar): leitura por requisição, sem cache de processo | Teste: alterar permissões → próxima requisição reflete |
| RF-08 | Hierarquia de gestão: só age (mudar papel, desativar, resetar senha) sobre membro de **rank menor**; owner nunca é rebaixado/removido por outro; admin não cria nem atribui papel personalizado | Testes das RPCs (matriz caller × alvo) |
| RF-09 | **1 proprietário por organização** (índice único parcial); transferência atômica; `owner_user_id` sempre coerente; último proprietário não sai | PGlite: segundo owner → 23505; transferência troca os dois e o ponteiro numa transação |
| RF-10 | Desativar membro (`status='disabled'`): revoga sessões, limpa equipe/atribuição, bloqueia login na organização, **auditado**; reativar possível; sem criar conta pessoal | Teste de rota + RPC; membro desativado → 403 em qualquer rota |
| RF-11 | Convite com papel de sistema **ou** personalizado (`role_id`), nominal opcional; papel apagado invalida convites pendentes; teto de TTL | Testes de criação/resgate; apagar papel em uso → 409 |
| RF-12 | Auditoria: criar/editar/apagar papel, atribuir/alterar papel de membro (antes→depois), convites (criar/revogar/aceitar), transferência, desativar/reativar, reset de senha, **tentativas negadas** (403) | Cada evento em `audit_logs` com ator, alvo, antes/depois, sem dados sensíveis |
| RF-13 | `GET /api/me/permissions` e `GET /api/account/permission-catalog` para o front (seção 8); rótulos em pt-BR | Contrato testado; `pages[]` substitui `ROUTE_ALLOWLIST` |
| RF-14 | Chaves de API: criar exige `api_keys.manage` e escopo ⊆ permissões do criador; chave pessoal recalcula `can()` do dono por requisição (já é o padrão) | Testes: rebaixar o dono reduz a chave pessoal; escopo acima do criador → 403 |
| RF-15 | Escopo de equipe: pares `X.all`/`X.team`/`X.own` (inbox, monitoramento, relatórios, Intelligence); RLS de `conversations`/`whatsapp_config` reescrita por permissão com resultado igual ao de hoje | Matriz dourada de visibilidade por papel |
| RF-16 | Lacunas fechadas: G1, G2, G3 (e P-05/P-07 conforme decisão) com `can()` | Testes de rota (viewer/agent → 403) |

### 5.2 Não funcionais

| ID | Requisito | Aceite |
|---|---|---|
| RNF-01 | Sem N+1: autorização custa **no máximo 1 leitura** por requisição (perfil + permissões numa consulta) | Contagem de queries em teste de rota |
| RNF-02 | RLS com `has_perm`: overhead ≤ 5% nas consultas quentes (inbox, conversas) | `EXPLAIN` antes/depois; `initPlan` único por statement |
| RNF-03 | Migração **sem downtime**: código novo + banco antigo e banco novo + código antigo funcionam (trigger de sincronia `account_role` ⇄ `role_id`) | Testes PGlite de ordem; feature flag do personalizado |
| RNF-04 | Falha de leitura de permissões = **negar** (fail-closed) | Teste de injeção de falha |
| RNF-05 | Papel personalizado só é liberável quando a cobertura da RLS portada = 100% (checklist gerado) | Teste que lista policies não portadas e falha se `custom_roles_enabled` e houver pendência |
| RNF-06 | Nenhuma migration trava tabela grande; índices únicos `CONCURRENTLY` em arquivo próprio | Revisão |

## 6. Desenho proposto

### 6.1 Modelo de dados (organização, papéis, permissões)

**Organização = `accounts`** (sem renomear; a UI chama de "Organização"). **1 usuário = 1 organização** mantido (`profiles.user_id` UNIQUE).

```
permission_catalog(key text pk, label, description, group, scope text['account'|'team'|'own'|'n/a'],
                   owner_only bool, grantable bool, depends_on text[], sort int)
account_roles(id uuid pk, account_id uuid NULL,           -- NULL = papel de sistema
              key text, name text, description text,
              kind text CHECK (kind IN ('system','custom')),
              rank int,                                    -- sistema: 5..1; personalizado: derivado (6.5)
              compat_role account_role_enum,               -- papel de sistema "equivalente" para checagens legadas (6.9)
              is_default bool, created_by, updated_by, created_at, updated_at,
              UNIQUE (account_id, key))
role_permissions(role_id uuid fk, permission text fk, PRIMARY KEY (role_id, permission))
profiles.role_id uuid fk account_roles   -- novo; profiles.account_role vira coluna COMPAT (derivada)
profiles.status text CHECK IN ('active','disabled'), disabled_at, disabled_by   -- desativação (RF-10)
account_invitations.role_id uuid fk account_roles  -- convite com papel de sistema ou personalizado
```
- **Papéis de sistema** (semeados, `account_id` NULL, imutáveis): `owner` (rank 5), `admin` (4), `supervisor` (3), `agent` ("Operador", 2), `viewer` ("Visualizador", 1). Conjuntos de permissões **definidos por tabela explícita** (não por rank) para reproduzir exceções não monotônicas de hoje (ex.: `inbox.receive_assignments` só `agent`; `inbox.delete_conversation` supervisor+; `flows.simulate` supervisor com leitura real de credencial só admin).
- **Papel personalizado**: `account_id` preenchido, `kind='custom'`; `rank` e `compat_role` calculados no servidor (6.5/6.9) — **nunca informados pelo cliente**.
- `account_role` continua existindo e **sincronizado** por trigger (`BEFORE INSERT/UPDATE` em `profiles`: se `role_id` muda, `account_role = compat_role`; se só `account_role` muda por RPC legada, `role_id` = papel de sistema correspondente) — é o que mantém **código antigo + banco novo** funcionando e permite migrar rotas/policies aos poucos.

### 6.2 Catálogo de permissões (inicial: equivalente ao papel mínimo de HOJE)

Legenda — **Mín.**: O=owner, A=admin, S=supervisor, G=agent/operador, V=viewer, *todos*; **Esc.**: escopo (`C`onta / `E`quipe / `P`róprio); **🔒** = `owner_only` (nunca entra em papel personalizado). Onde cada uma é checada: ver 2.2 e as notas de revisão (arquivo:linha).

| Grupo | Chave | Descrição | Mín. hoje | Esc. | 🔒 |
|---|---|---|---|---|---|
| Inbox | `inbox.view` | ver conversas (nível definido por `conversations.scope_*`) | G | C/E/P | |
| | `inbox.reply` | enviar mensagem, reagir, notas | G | — | |
| | `inbox.transfer` / `inbox.close` | transferir / encerrar-tabular | G | — | |
| | `inbox.delete_conversation` | excluir conversa | S | — | |
| | `inbox.ai_assist` | sentimento e sugestão de tag | G | — | |
| | `inbox.receive_assignments` | pode **receber** atribuição/handoff (hoje = papel `agent`) | G (**só** agent) | — | |
| | `inbox.quick_replies.manage` | cadastrar respostas rápidas | A | — | |
| | `calls.use` | VoIP | G (não-viewer) | — | |
| Escopo de conversas | `conversations.scope_all` / `scope_team` | ver todas da organização / só das equipes dele (sem ambas: só as dele + fila da equipe) | O,A,V = all; S = team; G = próprias+fila | C/E/P | |
| Contatos | `contacts.view` / `contacts.edit` | ver / editar e vincular | todos / G | — | |
| | `contacts.import` | importar (cria tags) | A | — | |
| | `tags.manage` | tags, tabulações, campos | A | — | |
| | `pipelines.manage` | funis e regras de negócio do CRM | A | — | |
| Equipe | `monitoring.view_team` / `monitoring.view_all` | monitoramento | S / A | E / C | |
| | `monitoring.assign` | reatribuir (arrastar) | A | — | |
| | `dashboard.view` | dashboard | S,A,O,V | — | |
| Relatórios | `reports.view_team` / `reports.view_all` | atendimento, conversas, tabulações, agentes / + envio em lote | S / A | E / C | |
| | `reports.export` / `exports.manage` | gerar exportação / listar-apagar | S / A | — | |
| | `audit.view` | auditoria e logs | A | — | |
| Intelligence | `intelligence.use` | chat, ferramentas, MCP | S | E | |
| | `intelligence.scope_account` | conta inteira (senão equipes) | A | C | |
| | `intelligence.personal_key` | criar a própria chave MCP | S | — | |
| Disparador | `campaigns.manage` | criar/editar/iniciar/pausar, listas, métricas, erros, UTM | A | — | |
| | `campaigns.rate_limit` | limite/s por número, reconhecer avisos | A | — | |
| | `campaigns.red_quality_override` | iniciar em número vermelho, política de qualidade | O | — | 🔒 |
| Fluxos/IA | `flows.edit` / `flows.view_runs` | criar-ativar-importar / ver execuções | A | — | |
| | `flows.simulate` | simulador (leitura real de credencial exige `secrets.write`) | S | — | |
| | `automations.view` / `automations.edit` | regras de automação | G / A | — | |
| | `ai.config` | chave, prompt, liga/desliga da IA | A (API) / O (UI) → **definir** | — | |
| | `ai.agents.view` / `ai.agents.edit` | perfis de agente | S / A | — | |
| | `ai.tools.view` / `ai.tools.edit` | ferramentas | S / A | — | |
| | `secrets.view_meta` / `secrets.write` | cofre (valor nunca volta) | S / A | — | |
| Canais | `channels.view` | listar linhas/canais (equipe para G/S) | todos | C/E | |
| | `channels.manage` | conectar, configurar, WAHA, webchat, tokens | A | — | |
| | `templates.view` / `templates.manage` | templates Meta e pastas | todos / A | — | |
| Pessoas | `teams.view` / `teams.manage` | equipes e membros de equipe | todos / A | — | |
| | `members.view` / `members.view_emails` | membros / e-mails | todos / A | — | |
| | `members.invite` / `members.manage` | convidar / mudar papel-equipe-limite, desativar | A | — | |
| | `members.reset_password` / `members.bulk_invite` | senha de outro / convite em lote | O | — | 🔒 |
| | `ownership.transfer` / `account.delete` | transferir propriedade / excluir organização | O | — | 🔒 |
| | `roles.manage` | **criar/editar/atribuir papéis personalizados** | O | — | 🔒 |
| Conta | `settings.account` | nome e configurações gerais | A | — | |
| | `api_keys.view` / `api_keys.manage` | chaves de API da organização | todos / A | — | |
| | `integrations.manage` | cofre de integrações por conta (PRD 19) | A | — | |

**Escopo é dimensão da chave**, não parâmetro: `X.view_all` ⊃ `X.view_team` (o verificador aceita a mais ampla). **Dependências** (validadas ao salvar): `campaigns.manage` ⇒ `channels.view`; `flows.edit` ⇒ `automations.view`; `members.manage` ⇒ `members.view`; `*.edit/manage` ⇒ `*.view`; `reports.export` ⇒ `reports.view_*`.

### 6.3 Verificação no servidor: `can()`

```ts
// src/lib/auth/permissions.ts  (puro, testável)
type Permission = keyof typeof PERMISSION_CATALOG;              // catálogo em código = catálogo da tabela
interface AuthContext { userId; accountId; role: SystemRoleKey; roleId; permissions: ReadonlySet<Permission>; status: 'active' }
can(ctx, perm): boolean            // perm ∈ ctx.permissions  (view_all ⊃ view_team)
requirePermission(perm)            // substitui requireRole/guardRole: 401/403 {code:'forbidden', permission}
```
- `getCurrentAccount()` passa a ler **uma** linha (`profiles ⨝ account_roles ⨝ role_permissions` agregado em `permissions text[]`) → `ctx.role` continua sendo o papel de sistema **compat** (então `isAccountRole` nunca falha por papel personalizado), `ctx.permissions` é a lista efetiva. **Sem cache de processo** (RF-07).
- `desativado` (`status='disabled'`) ⇒ `getCurrentAccount` devolve 403 `account_disabled`.
- Fail-closed: erro de leitura ⇒ nega.
- Mapeamento mecânico das checagens: `guardRole('admin')` ⇒ `requirePermission('<capacidade>')` por rota, conforme a tabela 6.2; um **teste de equivalência** garante que, para cada rota, `can(papel_de_sistema, perm)` = antigo `hasMinRole(papel, mínimo)`.

### 6.4 Verificação no banco: `has_perm()` e RLS

```sql
CREATE FUNCTION wacrm.has_perm(p_perm text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (SELECT 1 FROM wacrm.profiles p
        JOIN wacrm.role_permissions rp ON rp.role_id = p.role_id
       WHERE p.user_id = auth.uid() AND p.status = 'active' AND rp.permission = p_perm) $$;
```
- **1 organização por usuário ⇒ `has_perm(perm)` não recebe `account_id`**; a policy fica `USING (account_id = (SELECT wacrm.current_account_id()) AND (SELECT wacrm.has_perm('x')))`. Os `(SELECT …)` viram *initPlan* avaliado **uma vez por statement** (sem N+1 por linha) — o requisito RNF-02 é medido por `EXPLAIN`.
- `is_account_member(account, min_role)` **permanece** (compat) lendo o papel de sistema equivalente; as policies são portadas **domínio a domínio** (inbox/conversas; configuração; disparador; fluxos/automações; templates; tabelas administrativas; Storage/relatórios), cada PR com a matriz dourada (seção 9).
- As policies com literais (`062/106/107/131/141`) e as RPCs de relatório (P-05) passam a `has_perm`.
- **Pré-requisito do papel personalizado (RNF-05):** enquanto houver policy que ainda decide por `is_account_member(…,'agent')`, um papel personalizado cujo `compat_role` seja `agent` herdaria escrita **indevida** (P-07). Por isso: (a) a flag `custom_roles_enabled` só liga com 100% das policies portadas; (b) fechar P-07 já na fase de RLS (decisão: escrita do navegador em flows/automations/campanhas/blacklist/fila passa a exigir a permissão do domínio).

### 6.5 Hierarquia, teto e regras de borda

**Rank e `compat_role` do personalizado (calculados no servidor):** `compat_role` = o **menor** papel de sistema cujo conjunto de permissões ⊇ o do personalizado (se nenhum, `admin` — o teto); `rank` = `rank(compat_role) − 0,5`. Assim um personalizado nunca fica acima do admin e sempre fica **abaixo** do papel de sistema que o contém.

| Regra | Definição |
|---|---|
| **Teto** | Personalizado ⊆ conjunto do `admin` **menos** `owner_only` (`ownership.transfer`, `account.delete`, `roles.manage`, `members.reset_password`, `members.bulk_invite`, `campaigns.red_quality_override`). Validado na criação **e** a cada edição |
| **Quem cria/edita/atribui personalizado** | **Só o proprietário** (`roles.manage`). Admin recebe 403 e **não** vê o editor |
| **Atribuir papel de sistema** | owner: qualquer exceto `owner`; admin: ≤ `supervisor` (fase 1 mantém o que existe hoje — admin convida admin —; o endurecimento é o PR 20.4, **decisão do dono 13.3**) |
| **Hierarquia de gestão** (mudar papel, desativar, resetar senha, trocar equipe) | O executor só age sobre alvo de **rank menor** que o seu; owner age sobre todos; **admin não age sobre outro admin** (hoje age: P-02 — endurecimento aprovado pelo dono) |
| **Proprietário** | **Exatamente 1** por organização (índice único parcial em `role_id=owner`); não pode ser rebaixado, desativado ou removido por ninguém — só **transfere** (`ownership.transfer`) a um alvo ≥ admin, com reautenticação; a transferência troca os dois papéis e `accounts.owner_user_id` numa transação |
| **Último proprietário** | Impossível sair/ser removido (constraint + RPC) |
| **Papel em uso** | Apagar papel com membros ⇒ 409 `role_in_use` (lista os membros); reatribuir antes |
| **Convite** | Carrega `role_id`; não pode convidar `owner`; personalizado só se o convidante é owner; papel apagado ⇒ convites pendentes expiram |
| **Auto-alteração** | Ninguém altera o próprio papel (mantém `018:73`) |

### 6.6 Desativar membro (substitui "remover")

`deactivate_member(user, reason)` (RPC, DEFINER): `profiles.status='disabled'`, `disabled_at/by`; remove de `team_members` e zera `team_id`/`max_simultaneous_chats`; **revoga sessões** (rota usa `auth.admin.signOut(userId, 'global')`) e opcionalmente bane o usuário no Auth; **não** cria conta pessoal; **auditado**. `reactivate_member` restaura (sem equipe). Conversas abertas atribuídas ao membro: o PRD só **libera o vínculo técnico**; a **regra de destino é Decisão da operação** (4.1). `remove_account_member` legado é mantida só como compat até a fase 4 e passa a chamar `deactivate_member`.

### 6.7 Chaves de API e MCP

- Criar chave exige `api_keys.manage` **e** escopo ⊆ permissões do criador no momento da criação (G12); escopos da chave são um vocabulário próprio (`messages:send`, `contacts:*`, `campaigns:*`, `reports:read`, `intelligence:read`) mapeado a permissões (`messages:send` ⇒ `inbox.reply`, `campaigns:write` ⇒ `campaigns.manage`, `reports:read` ⇒ `reports.view_all`…).
- Chave **pessoal** (`intelligence:read`): já recalcula o papel do dono **a cada requisição** (`api-key.ts:56-70`); passa a recalcular `can()` (`intelligence.use` + `scope_account`) — rebaixar/desativar o dono reduz/derruba a chave.
- Chaves **de organização** (máquina) seguem independentes do papel do criador depois de criadas (decisão: **ao desativar o criador, a chave continua** — pergunta 13.8); acrescenta-se `reports:read_team` só se o dono pedir (G13).

### 6.8 Auditoria

Eventos novos (todos em `audit_logs`, com `account_id` **da organização afetada**, ator, alvo e antes→depois, sem dado sensível): `role.created/updated/deleted`, `role.permissions_changed` (diff de chaves), `member.role_changed`, `member.deactivated/reactivated`, `ownership.transferred`, `invitation.created/revoked/accepted` (com convidante e papel), `member.password_reset`, `api_key.created/revoked`, **`access.denied`** (403 com a permissão faltante, com limite de frequência). Triggers novos em `account_roles`, `role_permissions`, `account_invitations`, `accounts` (nome/`owner_user_id`) e `profiles` (`role_id`, `status`); correção da atribuição de conta errada (P-09: o evento de mudança de vínculo usa a conta **antiga**).

### 6.9 Compatibilidade e migração sem downtime (3 fases)

1. **Fase 1 — fundação, comportamento idêntico.** Tabelas + catálogo + papéis de sistema semeados; `profiles.role_id` preenchido para todos; trigger de sincronia; `has_perm`/`can()` existem; rotas/policies **migram por domínio** com a matriz dourada (resultado igual ao de hoje para os 5 papéis); lacunas G1–G3 fechadas. `account_role` segue valendo para código antigo.
2. **Fase 2 — endurecimento aprovado.** Hierarquia (P-02), dono único (P-04), desativar membro (P-03), convite fix (P-10/P-12), auditoria (P-09), alinhamento da RLS (P-05/P-07) — **cada um com decisão do dono** (13.x) e PR próprio.
3. **Fase 3 — papel personalizado.** CRUD de papéis, atribuição, convite com papel, `GET /me/permissions`, flag `custom_roles_enabled` (liga só com RLS 100% portada). Limpeza: remover `ROUTE_ALLOWLIST`/`useCan` legados, `account_role` vira apenas compat de leitura.

Ordem de implantação por PR: migration **antes** do deploy (código tolera ausência: cai no `account_role`), flag desligada, ligar por organização-piloto.

### 6.10 Um usuário, várias organizações — **fora do escopo** (custo)

O pedido do dono é **1 organização por usuário**. Se um dia quiserem, o custo (levantado no banco e no código): (i) tabela `account_members(account_id, user_id, role_id, team_id, max_chats, status)` + backfill; (ii) **"organização ativa"** (claim via Custom Access Token Hook ou `set_config` por requisição) e reescrever as 4 funções que resolvem por `auth.uid()` com `LIMIT 1` (`current_user_role`, `current_user_team_ids`, `current_account_id`, `report_sees_*`); (iii) reescrever `is_account_member` e ~12 policies que leem `profiles` direto (`062`, `106`, `107`, `131:60`, `141:43`, `055:48`, `072:69`); (iv) relaxar as 2 unicidades (`profiles.user_id`, `accounts.owner_user_id`); (v) reescrever 7 RPCs (`set_member_*`, `remove`, `transfer`, `redeem`, `handle_new_user`, `peek`) — hoje o ciclo de vida é "mover o profile" e `redeem_invitation` **apaga** a conta pessoal; (vi) `getCurrentAccount` (30 arquivos) + seletor de organização na UI; (vii) auditoria e presença por organização. Os 4 pontos de maior risco: `has_perm(perm)` sem `account_id` (passaria a depender da organização ativa), policies que leem `profiles`, `redeem_invitation`, e o trigger de auditoria que usa `NEW.account_id`. **Decisão de design deste PRD que reduz o custo futuro:** `has_perm` e `can` já recebem a organização do contexto, e `role_id` fica no vínculo (hoje `profiles`) — migrar para `account_members` seria trocar a tabela, não o modelo.

## 7. Dados e migrations (faixa 240–249)

Todas manuais, idempotentes, com **PRÉ-CHECK vivo** que aborta sem alterar (padrão 192); índices únicos `CONCURRENTLY` em arquivo próprio. Conferir o schema vivo antes (drift `public`×`wacrm`, P-19).

| Nº | O que faz | Ordem vs deploy | CONC. | Rollback |
|---|---|---|---|---|
| 240 | `permission_catalog` (seed), `account_roles` (+ papéis de sistema semeados), `role_permissions` (seed = comportamento de hoje), `profiles.role_id` (nullable) + backfill + trigger de sincronia `account_role`⇄`role_id` | ANTES do deploy (código antigo ignora) | não | `DROP` das tabelas/coluna/trigger |
| 241 | Funções: `has_perm(text)`, `my_permissions()`, `role_rank(uuid)`, `compat_role_for(perms)`; `current_account_id()` revisada | antes | não | `DROP FUNCTION` |
| 242 | `profiles.status/disabled_at/disabled_by`; RPCs `deactivate_member`/`reactivate_member`; **hierarquia** em `set_member_role` e `transfer_account_ownership` (alvo ≥ admin) | antes do PR 20.4; muda comportamento ⇒ após decisão do dono | não | restaurar corpos antigos (guardados no cabeçalho) |
| 243 | **1 owner por organização**: pré-check/saneamento de contas com ≠ 1 owner + `bulk-invite` sem owner | antes (pré-check obrigatório) | não | — |
| 243b | `CREATE UNIQUE INDEX CONCURRENTLY idx_profiles_one_owner ON wacrm.profiles (account_id) WHERE account_role = 'owner'` (e por `role_id`) | **DEPOIS** da 243, sozinho | **sim** | `DROP INDEX CONCURRENTLY` |
| 244 | `account_invitations.role_id` (+ backfill de `role`), TTL máximo, e-mail nominal opcional, `token_hash` fora do SELECT de `authenticated` (view/colunas) | antes | não | `DROP COLUMN` |
| 245 | **RLS portada — Domínio A**: inbox/conversas/mensagens, contatos, tags, pipelines, deals (`has_perm`; visibilidade por `conversations.scope_*`) | com a matriz dourada verde | não | recriar policies antigas (arquivo de rollback gerado) |
| 246 | **RLS portada — Domínio B**: canais/whatsapp_config, templates, teams/team_*, quick_replies, clients, `api_keys`, `accounts`/`account_invitations`, `audit_logs`, `intelligence_tool_calls` | idem | não | idem |
| 247 | **RLS portada — Domínio C**: disparador (campanhas, fila, blacklist, métricas), flows/automations, `export_history` e Storage, RPCs de relatório (P-05/P-07) | idem | não | idem |
| 248 | Auditoria: triggers em `account_roles`, `role_permissions`, `account_invitations`, `accounts`; conta correta no evento de mudança de vínculo (P-09) | antes ou depois | não | `DROP TRIGGER` |
| 249 | Reservada: limpeza (descartar `account_role` como fonte; remover cópias em `public`) **só depois** da fase 3 estável | depois | — | — |

**Pré-checks:** Anexo A (contas e membros, owners ≠ 1, órfãos, convites, enum, policies, triggers, ACL de funções, unicidades). **Matriz dourada** (seção 9) é o gate de cada migration 245–247.

## 8. Contrato para o frontend

> Front é de outra pessoa; só consome. Erros: `{error:{code, message, ...extra}}`; todas as rotas `Cache-Control: no-store`; textos em pt-BR.

| Rota | Método | Permissão | Payload / resposta | Erros |
|---|---|---|---|---|
| `/api/me/permissions` | GET | sessão | `{ organization:{id,name}, role:{id,key,name,kind:'system'\|'custom',rank}, permissions:['inbox.reply',…], scopes:{inbox:'team'\|'all'\|'own', monitoring:…, reports:…, intelligence:…}, pages:['/inbox','/dashboard',…], status:'active' }` — substitui `ROUTE_ALLOWLIST`/`useCan` | 401; 403 `account_disabled` |
| `/api/account/permission-catalog` | GET | `roles.manage` ou `members.view` | `{groups:[{key,label,permissions:[{key,label,description,scope,ownerOnly,grantable,dependsOn}]}]}` | 403 |
| `/api/account/roles` | GET | `members.view` | `[{id,key,name,kind,rank,memberCount,permissionsCount}]` (sistema + personalizados) | — |
| `/api/account/roles` | POST | **`roles.manage`** (proprietário) | `{name, description, permissions:[…], baseOn?: roleId}` → cria; `rank`/`compat_role` calculados | 403 `forbidden`; 422 `owner_only` / `not_grantable` / `missing_dependency` / `unknown_permission`; 409 `name_taken` |
| `/api/account/roles/{id}` | GET | `members.view` | detalhe + permissões + membros (nomes) | 404 |
| `/api/account/roles/{id}` | PATCH / DELETE | `roles.manage` | edita nome/permissões (diff gravado) / apaga | 409 `role_in_use` (lista membros); 403 papel de sistema |
| `/api/account/roles/{id}/duplicate` | POST | `roles.manage` | cria cópia editável | — |
| `/api/account/members/{userId}` | PATCH | `members.manage` (+ `roles.manage` se o papel é personalizado) | `{role_id?, team_id?, max_simultaneous_chats?}` | 403 `hierarchy_violation`; 409 `last_owner`; 422 `role_not_assignable` |
| `/api/account/members/{userId}/deactivate` · `/reactivate` | POST | `members.manage` | `{reason}` → `{status}` | 403 `hierarchy_violation`; 409 `last_owner` |
| `/api/account/invitations` | POST | `members.invite` (+ `roles.manage` p/ personalizado) | `{role_id, email?, expires_in_days≤30}` | 422 `role_not_assignable`; 403 |
| `/api/account/transfer-ownership` | POST | `ownership.transfer` | `{new_owner_user_id, password}` (reautenticação) | 422 alvo < admin; 403 |
| `/api/account/members` | GET | `members.view` | inclui `role:{id,key,name,kind}` e `status` | — |
| Qualquer rota protegida | — | — | 403 `{error:{code:'forbidden', permission:'campaigns.manage'}}` — o front pode mostrar "sem permissão para …" | — |

Regras de UI que o contrato sustenta: o editor de papéis é **visível só ao proprietário**; permissões `ownerOnly`/não `grantable` aparecem **desabilitadas** com explicação; `dependsOn` liga/desliga em cascata; nenhum controle depende de `account_role` — só de `permissions`/`scopes`/`pages`.

## 9. Testes e aceite

| Camada | O que prova | Onde |
|---|---|---|
| **Matriz dourada (SQL)** | Para cada (papel de sistema × tabela × comando) e (papel × cenário de visibilidade de conversas/canais), o resultado das policies **novas** = o das **antigas** (carrega ambas num PGlite, executa `SET ROLE`/`auth.uid()` simulado) — gate de 245–247 | PGlite `*.sql.test.ts` (timeout 60 s, PRD 15 P-08) |
| **Equivalência de rotas (TS)** | Para cada rota, `can(papel, perm)` = antigo `hasMinRole(papel, mínimo)`; lista de rotas gerada do inventário | vitest (tabela de 146 rotas) |
| **Teto e hierarquia** | Papel personalizado nunca contém `owner_only`/excede admin; admin não age sobre admin; último owner; transferência atômica | PGlite (RPCs) + vitest (rotas) |
| **Isolamento por organização** | Usuário da org A nunca lê/escreve a org B em todas as tabelas com `account_id` (teste gerado do catálogo de tabelas) | PGlite |
| **Efeito imediato / fail-closed** | Mudar permissões vale na próxima requisição; falha de leitura nega | vitest |
| **Auditoria** | Cada evento da 6.8 grava ator/alvo/antes→depois e na conta certa | vitest + PGlite |
| **Lint** | Sem `hasMinRole(`/`account_role ===` em `src/app/api/**` (fim da fase 3) | CI |
| **Staging** | Organização-piloto com papel personalizado; `EXPLAIN` das policies quentes; `custom_roles_enabled` bloqueado se houver policy não portada | Supabase de desenvolvimento |

**"Pronto" =** (a) matriz dourada 100% verde; (b) nenhuma checagem por string de papel no servidor; (c) proprietário cria um papel "Atendente sênior" no piloto e ele funciona na tela **e** na API **e** no PostgREST; (d) admin recebe 403 ao tentar criar/atribuir papel personalizado; (e) 1 owner por organização no live; (f) P-02/P-03/P-04 fechados.

## 10. Observabilidade

| Sinal | Fonte | Limiar | Gravidade | Canal |
|---|---|---|---|---|
| `access.denied` por permissão | `audit_logs` | picos por usuário/permissão | média | revisão semanal |
| Organização com owners ≠ 1 | job/consulta Anexo A-3 | qualquer | **alta** | alerta (PRD 15) |
| Usuário sem profile/role (`handle_new_user` falhou) | Anexo A-4 | qualquer | alta | alerta |
| Mudança de papel/permissões, convite, transferência, desativação | `audit_logs` | cada uma | info | tela de auditoria |
| Policy não portada com `custom_roles_enabled` | checklist gerado | qualquer | **alta** | bloqueia o flag |
| Latência de `getCurrentAccount` | `writeLog` amostrado | p95 > 50 ms | média | monitor |
| Convites expirados/pendentes antigos | consulta | acima do teto | baixa | semanal |

## 11. Riscos, rollback e plano de implantação

| Risco | Mitigação |
|---|---|
| Portar ~150 policies muda comportamento sem querer | **Matriz dourada** como gate; um domínio por PR; rollback = arquivo de policies antigas gerado da própria migration |
| Papel personalizado herdar escrita indevida pelo `compat_role` (P-07) | `custom_roles_enabled` só liga com RLS 100% portada (RNF-05) |
| RLS mais lenta (`has_perm` por linha) | `initPlan` por statement; `EXPLAIN` no staging; índice em `role_permissions (role_id, permission)` |
| Endurecimentos (admin×admin, dono único, desativar) surpreendem a operação | PRs separados da fundação, **cada um com decisão do dono**; aviso na tela; organização-piloto |
| Contas com 0 ou >1 owner no live | Anexo A-3 antes da 243; saneamento **manual e revisado** (nunca automático) |
| Trigger de sincronia `account_role`⇄`role_id` com loop | testes PGlite de ambos os sentidos; `WHEN (OLD IS DISTINCT FROM NEW)` |
| Front adiante do back | contrato estável (seção 8); `/me/permissions` primeiro; front migra `useCan` aos poucos (legado coexiste) |
| Drift `public`×`wacrm` | reconciliar (P-19) antes da 241; pré-check de funções duplicadas |

**Ordem:** 20.1 (código puro) → 240/241 + `getCurrentAccount` → migração de rotas por domínio com G1–G3 → RLS por domínio (245–247) → endurecimentos aprovados (242/243/244/248) → papel personalizado (flag por organização) → limpeza.

## 12. Fases e PRs

Tamanho: P ≤ 1 dia, M 2–4, G > 4. **Todos com base `v2`**, sem empilhar (cada um parte de `origin/v2`). BE = backend.

| # | PR | Conteúdo | Dep. | Dono | Tam. |
|---|---|---|---|---|---|
| 20.1 | `permissoes-catalogo` | `lib/auth/permissions.ts` (catálogo, conjuntos dos papéis de sistema, `can`, dependências) + testes de **equivalência** com `hasMinRole` para as 146 rotas; docs | — | BE | M |
| 20.2 | `papeis-fundacao` | migrations 240/241; `getCurrentAccount` carrega `permissions` (compat); trigger de sincronia; sem mudança de comportamento | 20.1, PRD 14 (drift) | BE | G |
| 20.3a | `can-conta-membros` | migrar `account/**`, `api-keys`, `invitations`, `audit-logs` para `requirePermission` | 20.2 | BE | M |
| 20.3b | `can-canais` | `whatsapp/*`, `channels/*`, templates, webchat; **fecha G1** | 20.2 | BE | M |
| 20.3c | `can-disparador` | `requireDisparadorAccess`→`can(campaigns.*)`; `rate-limits-service`, `red-quality-gate`, `start/stop`; **fecha G2** | 20.2 | BE | M |
| 20.3d | `can-fluxos-ia` | flows, automations, `settings/{agents,tools,secrets}`, `ai-config`, simulador; **fecha G3** | 20.2 | BE | M |
| 20.3e | `can-inbox-relatorios` | inbox, conversas, monitoramento, relatórios/exports, calls, lines | 20.2 | BE | M |
| 20.3f | `can-intelligence-chaves` | `intelligence/scope`, `api-key` (recalcula `can`), escopo da chave ⊆ criador | 20.3a | BE | M |
| 20.4 | `hierarquia-dono-unico` | migrations 242/243/243b; hierarquia nas RPCs; 1 owner; `bulk-invite` sem owner; **P-02/P-04**; (**decisão 13.2/13.3**) | 20.2 | BE | G |
| 20.5 | `desativar-membro` | `deactivate/reactivate`, revogar sessões, limpar equipe; **P-03**; (regra das conversas = operação) | 20.4 | BE | M |
| 20.6 | `convites-papel` | migration 244; convite com `role_id`, TTL, nominal, `token_hash` oculto; **P-10/P-11/P-12** | 20.4 | BE | M |
| 20.7a/b/c | `rls-dominio-a/b/c` | migrations 245/246/247 + matriz dourada; **P-05/P-07/P-08**; (decisão P-06) | 20.3* | BE | G cada |
| 20.8 | `auditoria-papeis` | migration 248 + eventos da 6.8 + `access.denied`; **P-09** | 20.2 | BE | M |
| 20.9 | `papeis-personalizados` | CRUD, atribuição, validações (teto/dependências), flag `custom_roles_enabled`, contrato da seção 8 | 20.7*, 20.8 | BE | G |
| 20.10 | `me-permissions` | `GET /me/permissions`, `permission-catalog`, `pages[]` (para o front trocar `useCan`/`ROUTE_ALLOWLIST`) | 20.2 | BE | P |
| 20.11 | `limpeza-papeis` | remover `ROUTE_ALLOWLIST`/`useCan` legados, `protectedPaths` completo, código morto, migration 249 | 20.9, 20.10 | BE | M |

Dependências críticas: 20.9 só depois da **RLS 100% portada** (20.7*); 20.4–20.6 mudam comportamento ⇒ exigem as respostas de 13.1–13.9.

## 13. Perguntas ao dono e itens "A confirmar no live"

### 13.1 Perguntas ao dono (decisão)

1. **Um proprietário por organização?** Proponho **exatamente 1** (admin é "quase igual", então co-gestão = admin). Isso exige corrigir contas que hoje tenham mais de um `owner` (efeito do `bulk-invite`). Aceita?
2. **Admin gerencia outro admin?** Hoje um admin consegue rebaixar/remover outro admin. Proponho: **só o proprietário gerencia admins** (admin gerencia supervisor/operador/visualizador/personalizados "abaixo"). Aceita?
3. **Atribuição de papel personalizado:** só o **proprietário** cria **e atribui** (proposta). O **admin** poderia **atribuir** (não criar) um papel personalizado já existente? Recomendo **não** na primeira versão.
4. **Visualizador (`viewer`):** manter como **papel de sistema** ("Visualizador", somente leitura; recomendado) ou convertê-lo em um papel personalizado que cada organização cria se quiser? Quantos viewers existem hoje (Anexo A-2)?
5. **Nomes na tela:** "Proprietário", "Administrador", "Supervisor", "Operador" (e "Visualizador")? "Organização" no lugar de "conta"?
6. **Teto do personalizado:** nunca acima do admin e sem as 6 permissões 🔒 (propriedade, excluir organização, gerir papéis, reset de senha, convite em lote, número vermelho). Concorda com essa lista?
7. **Desativar × excluir membro:** desativar (revoga sessões, mantém histórico e auditoria) como padrão, com exclusão definitiva só por pedido do titular (PRD 14, LGPD). Aceita? **Decisão da operação:** o que fazer com as conversas abertas do membro desativado (reatribuir, devolver à fila, encerrar)?
8. **Chaves de API criadas por quem sai:** ao desativar um membro, as chaves de **organização** que ele criou continuam (padrão) ou são revogadas? As chaves **pessoais** (MCP) caem automaticamente.
9. **Convites:** passam a ser **nominais** (e-mail obrigatório) e com validade máxima de **30 dias** (hoje até 365)? E o `redeem-by-code` (sem gerador hoje): remover?
10. **Visualizador × operador na visibilidade (P-06):** hoje o visualizador vê **mais** conversas que o operador. Corrigir (visualizador sem inbox ou limitado) ou manter? (muda o que ele enxerga)
11. **Operador escreve flows/campanhas pelo console (P-07):** a UI não dá essa permissão ao operador; confirma que a RLS deve **negar** (alinhar ao que a tela já faz)?
12. **Contas existentes:** o que você sabe sobre as "2 organizações"? Rode o Anexo A-2/A-3 e me passe o resultado (quantos membros por papel e se há owners ≠ 1).
13. **Várias organizações por usuário:** confirma que **não** entra agora (custo na 6.10)? Haverá usuários que precisam acessar duas empresas (ex.: consultor/suporte DDM)? Se sim, o desenho já deixa o caminho aberto, mas é um projeto próprio.

### 13.2 A confirmar no live (e como)

| # | O que | Como | Item |
|---|---|---|---|
| 1 | Quantas organizações existem, nome, criada em, **membros por papel** | Anexo A-2 | pergunta do dono |
| 2 | Contas com **0 ou >1 owner**, ponteiro `owner_user_id` divergente, contas órfãs, usuários sem profile | Anexo A-3/A-4 | P-04, P-16 |
| 3 | Enum real e ordem; funções de papel: schema (cópia em `public`?), `search_path`, ACL | Anexo A-1/A-8 | P-19 |
| 4 | Policies que dependem de papel e as que **não exigem papel** | Anexo A-6 | P-07, P-08 |
| 5 | Privilégio de UPDATE de `authenticated` em `accounts` (principalmente `owner_user_id`), `account_invitations`, `ai_config`, `api_keys` | Anexo A-9 | R-7/P-12 |
| 6 | RLS real de `whatsapp_config`/`channels` (agent consegue DELETE/PATCH? — G1) | `pg_policies` | G1 |
| 7 | Triggers em `profiles`/`accounts`/`auth.users` e se `trg_audit_profiles` está ativo | Anexo A-7 | P-09 |
| 8 | Convites pendentes por conta/papel e maior TTL | Anexo A-5 | P-12 |
| 9 | `profiles.team_id` × `team_members` (quantos têm um e não o outro) | consulta | P-17 |
| 10 | Signups públicos habilitados no Supabase Auth (cada signup vira uma organização) | painel Auth | 2.1 |
| 11 | Existe `wacrm.account_members` (a 048 cita um trigger apontando para uma tabela inexistente)? | `to_regclass` | 6.10 |
| 12 | Corpo vigente de `set_member_role`, `remove_account_member`, `transfer_account_ownership`, `redeem_invitation` | Anexo A-8 | P-02/P-03 |

---

## Anexo A — SQL de verificação (somente leitura) para o dono rodar no SQL Editor

> Projeto de produção `cyftbffhgjmsfogxawrl`. Nada foi executado nesta revisão. **A-2 responde "quantas organizações e quem está em cada uma".**

```sql
-- A-1. Enum atual (ordem) e onde ele existe
SELECT n.nspname, t.typname, enum_range(NULL::wacrm.account_role_enum) AS valores
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'account_role_enum';

-- A-2. Organizações: id, nome, criada em e nº de membros por papel
SELECT a.id, a.name, a.created_at, a.owner_user_id,
       count(*) FILTER (WHERE p.account_role = 'owner')      AS owners,
       count(*) FILTER (WHERE p.account_role = 'admin')      AS admins,
       count(*) FILTER (WHERE p.account_role = 'supervisor') AS supervisores,
       count(*) FILTER (WHERE p.account_role = 'agent')      AS operadores,
       count(*) FILTER (WHERE p.account_role = 'viewer')     AS viewers,
       count(p.user_id) AS total
FROM wacrm.accounts a LEFT JOIN wacrm.profiles p ON p.account_id = a.id
GROUP BY a.id ORDER BY a.created_at;

-- A-3. Contas cujo número de owners ≠ 1 ou cujo ponteiro owner_user_id não bate com o papel
SELECT a.id, a.name, a.owner_user_id,
       count(*) FILTER (WHERE p.account_role = 'owner') AS owners_por_papel,
       bool_or(p.user_id = a.owner_user_id AND p.account_role = 'owner') AS ponteiro_coerente
FROM wacrm.accounts a LEFT JOIN wacrm.profiles p ON p.account_id = a.id
GROUP BY a.id
HAVING count(*) FILTER (WHERE p.account_role = 'owner') <> 1
    OR NOT coalesce(bool_or(p.user_id = a.owner_user_id AND p.account_role = 'owner'), false);

-- A-4. Usuários sem profile/conta/papel; contas sem membros; owners "extras"
SELECT u.id, u.email FROM auth.users u LEFT JOIN wacrm.profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL OR p.account_id IS NULL OR p.account_role IS NULL;
SELECT a.id, a.name, a.owner_user_id FROM wacrm.accounts a
WHERE NOT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.account_id = a.id);
SELECT p.user_id, p.account_id FROM wacrm.profiles p JOIN wacrm.accounts a ON a.id = p.account_id
WHERE p.account_role = 'owner' AND a.owner_user_id <> p.user_id;

-- A-5. Convites pendentes por conta/papel
SELECT account_id, role, count(*) FILTER (WHERE expires_at > now()) AS pendentes,
       count(*) FILTER (WHERE expires_at <= now()) AS expirados, max(expires_at - created_at) AS maior_ttl
FROM wacrm.account_invitations WHERE accepted_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2;

-- A-6. Policies que dependem de papel, e as que NÃO exigem papel mínimo (qualquer membro escreve)
SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
WHERE schemaname IN ('wacrm','storage')
  AND (qual ILIKE '%account_role%' OR qual ILIKE '%is_account_member%'
    OR with_check ILIKE '%account_role%' OR with_check ILIKE '%is_account_member%')
ORDER BY tablename, cmd, policyname;
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'wacrm' AND cmd IN ('ALL','INSERT','UPDATE','DELETE')
  AND (qual ~ 'is_account_member\(\s*[a-z_.]+\s*\)' OR with_check ~ 'is_account_member\(\s*[a-z_.]+\s*\)');

-- A-7. Triggers em profiles / accounts / convites / api_keys / auth.users
SELECT event_object_schema, event_object_table, trigger_name, action_timing, event_manipulation
FROM information_schema.triggers
WHERE (event_object_schema = 'wacrm' AND event_object_table IN ('profiles','accounts','account_invitations','api_keys'))
   OR (event_object_schema = 'auth' AND event_object_table = 'users');

-- A-8. Funções de membro/papel: schema, definer, search_path e ACL (esperado: só wacrm; cópia em public = lixo/risco)
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.proconfig,
       (SELECT array_agg(a.grantee::regrole::text || ':' || a.privilege_type)
          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname IN ('is_account_member','current_user_role','current_user_team_ids','current_account_id',
  'report_sees_conversation','report_sees_user','set_member_role','remove_account_member',
  'transfer_account_ownership','set_member_team','set_member_max_simultaneous_chats',
  'redeem_invitation','peek_invitation','handle_new_user','profiles_guard_privileged_columns')
ORDER BY p.proname, n.nspname;
SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('wacrm','public')
  AND p.proname IN ('set_member_role','remove_account_member','transfer_account_ownership','redeem_invitation');

-- A-9. Privilégios do authenticated nas tabelas de organização/papel
SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
WHERE table_schema = 'wacrm' AND grantee = 'authenticated'
  AND table_name IN ('profiles','accounts','account_invitations','whatsapp_config','ai_config','api_keys')
  AND privilege_type IN ('UPDATE','INSERT','SELECT')
ORDER BY table_name, privilege_type, column_name;

-- A-10. Unicidades em profiles/accounts/convites
SELECT conrelid::regclass, conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid IN ('wacrm.profiles'::regclass, 'wacrm.accounts'::regclass, 'wacrm.account_invitations'::regclass);
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'wacrm' AND tablename IN ('profiles','accounts');

-- A-11. Auditoria de papéis/convites já gravada
SELECT action, count(*), min(created_at), max(created_at) FROM wacrm.audit_logs
WHERE action ILIKE 'member.%' OR resource_type IN ('member','invitation','account','api_key') GROUP BY 1;

-- A-12. Equipes: usuários com profiles.team_id sem team_members (e vice-versa)
SELECT (SELECT count(*) FROM wacrm.profiles p WHERE p.team_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM wacrm.team_members tm WHERE tm.user_id = p.user_id)) AS so_profiles_team_id,
       (SELECT count(*) FROM wacrm.team_members tm
         WHERE NOT EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = tm.user_id AND p.team_id = tm.team_id)) AS so_team_members;
```
