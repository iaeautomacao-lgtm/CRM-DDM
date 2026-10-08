# Inventário de Rotas — CRM-DDM (Branch `v2`)

Inventário mecânico de todas as **146 rotas** HTTP sob `src/app/api/**/route.ts`.

| rota | métodos | autenticação | papel mínimo | usa service role (supabaseAdmin)? | filtra account_id? (sim/não/parcial) | rate limit? | valida corpo (zod/manual/não) | observação |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/account` | GET, PATCH | requireRole | admin | não | sim | sim (checkRateLimit) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/account/ai-config` | GET, POST | guardRole | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/account/api-keys` | GET, POST | requireRole | admin | sim (e ctx.supabase) | sim | sim (checkRateLimit) | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/account/api-keys/[id]` | DELETE | getCurrentAccount | agent | sim (e ctx.supabase) | sim | sim (checkRateLimit) | não (DELETE) | Acesso escopado à conta do usuário autenticado. |
| `/api/account/invitations` | GET, POST | requireRole | admin | não | sim | sim (checkRateLimit) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/account/invitations/[id]` | DELETE | requireRole | admin | não | sim | sim (checkRateLimit) | não (DELETE) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/account/members` | GET | getCurrentAccount | agent | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/account/members/[userId]` | PATCH, DELETE | requireRole | admin | não | sim (via RLS) | sim (checkRateLimit) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/account/members/[userId]/reset-password` | POST | requireRole | owner | sim | sim | sim (checkRateLimit) | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/account/members/bulk-invite` | POST | requireRole | owner | sim | sim | sim (checkRateLimit) | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/account/presence` | POST | getCurrentAccount | agent | não | sim (via RLS) | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/account/teams/[teamId]/members` | GET, POST, DELETE | requireRole | admin | não | sim | sim (checkRateLimit) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/account/transfer-ownership` | POST | requireRole | owner | não | sim (via RLS) | sim (checkRateLimit) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/ai/prompt-versions` | GET | requireRole | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/audit-logs` | GET | requireRole | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/automations` | GET, POST | guardRole | agent/admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/automations/[id]` | GET, PATCH, DELETE | guardRole | agent/admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/automations/[id]/duplicate` | POST | guardRole | admin | sim | sim | não | não | Acesso com service role filtrando estritamente account_id. |
| `/api/automations/cron` | POST | x-cron-secret | - | sim | parcial | não | não (GET) | Endpoint operacional executado por agendador externo/cron. |
| `/api/automations/engine` | POST | guardRole | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/calls/[...path]` | GET, POST, DELETE | getCurrentAccount | agent | não | sim | não | não (GET) | Proxy reverso autenticado para o servidor VoIP em Go com headers internos. |
| `/api/channels` | GET | getCurrentAccount | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/channels/[type]` | PATCH, DELETE | requireRole | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/channels/[type]/callback` | GET | requireRole | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/channels/[type]/connect` | GET | requireRole | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/channels/refresh-tokens` | POST | x-cron-secret | - | sim | não | não | não (GET) | Ações registradas com contexto de auditoria (audit actor). |
| `/api/chat-media/[...path]` | GET | getCurrentAccount | agent | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/contacts/[id]/link` | POST | requireRole | agent | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/conversations/[id]/close` | POST | requireRole | agent | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/conversations/[id]/flow-runs` | GET | requireRole | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/conversations/[id]/origin` | GET | getCurrentAccount | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/conversations/[id]/sentiment` | POST | guardRole | agent | não | sim | sim (checkRateLimit) | não | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/conversations/[id]/suggest-tag` | GET | requireRole | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/conversations/[id]/transfer` | POST | requireRole | agent | sim | sim | não | manual | Ações registradas com contexto de auditoria (audit actor). |
| `/api/conversations/retry-assignment` | POST | x-cron-secret | - | sim | parcial | não | não | Acesso escopado à conta do usuário autenticado. |
| `/api/ddm-logs` | GET | requireRole | admin | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/audience/blacklist` | POST | requireDisparadorAccess | agent | sim | não | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/audience/preview` | POST | requireDisparadorAccess | agent | sim | parcial | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/campaigns` | POST | requireDisparadorAccess | agent | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/[id]` | PATCH, DELETE | requireDisparadorAccess | agent | sim | parcial | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/campaigns/[id]/audience` | GET | getCurrentAccount | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/[id]/info` | GET | getCurrentAccount | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/[id]/queue-details` | GET | requireDisparadorAccess | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/[id]/start` | POST | supabase.auth.getUser / canManageCampaigns ou x-cron-secret | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/[id]/stop` | POST | supabase.auth.getUser / canManageCampaigns | admin | sim | sim | não | não | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/[id]/timing` | GET | requireDisparadorAccess | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/[id]/unschedule` | POST | requireDisparadorAccess | agent | sim | sim | não | não | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/planned-metrics` | POST | requireDisparadorAccess | agent | sim | sim | não | não | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/campaigns/recalculate-metrics` | GET | requireRole | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/disparador/contacts/import` | POST | requireDisparadorAccess | agent | sim | sim | não | zod | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/cron` | GET, POST | x-cron-secret | - | sim | parcial | não | não | Endpoint operacional executado por agendador externo/cron. |
| `/api/disparador/desempenho` | GET | requireDisparadorAccess | agent | sim | parcial | não | não (GET) | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/desempenho/live` | GET | requireDisparadorAccess | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/disparador/erros` | GET | requireDisparadorAccess | agent | sim | parcial | não | não (GET) | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/erros/[id]` | GET | requireDisparadorAccess | agent | sim | parcial | não | não (GET) | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/health/cron` | POST | x-cron-secret | - | sim | não | não | não | Endpoint operacional executado por agendador externo/cron. |
| `/api/disparador/health/refresh` | POST | requireDisparadorAccess | agent | sim | parcial | sim (checkRateLimit) | não | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/limits` | GET, PUT | requireDisparadorAccess | agent | sim | parcial | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/monitor/snapshot` | GET | requireDisparadorAccess | agent | sim | parcial | não | não (GET) | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/prepare/cron` | POST | x-cron-secret | - | sim | não | não | não | Endpoint operacional executado por agendador externo/cron. |
| `/api/disparador/rate-limits` | GET, PUT | requireDisparadorAccess | agent | sim | parcial | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/rate-limits/[session]/revert-auto` | POST | requireDisparadorAccess | agent | sim | parcial | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/rate-limits/acknowledge` | POST | requireDisparadorAccess | agent | sim | parcial | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/ritmo` | GET | requireDisparadorAccess | agent | sim | parcial | não | não (GET) | Acesso escopado à conta do usuário autenticado. |
| `/api/disparador/utm` | POST | requireDisparadorAccess | agent | não | não | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/disparador/utm/metricas` | GET | requireDisparadorAccess | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/feedback` | POST | getCurrentAccount | agent | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/flows` | GET, POST | guardRole (guardFlow) | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/flows/[id]` | GET, PUT, DELETE | guardRole (guardFlow) | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/flows/[id]/activate` | POST | guardRole (guardFlow) | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/flows/[id]/export` | GET | guardRole (guardFlow) | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/flows/[id]/runs` | GET, DELETE | guardRole (guardFlow) | admin | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/flows/[id]/simulate` | POST | getCurrentAccount | agent | sim | sim | sim (checkRateLimit) | zod | Simulador de fluxos em tempo real com execução em memória. |
| `/api/flows/cron` | POST, GET | x-cron-secret | - | sim | não | não | não | Endpoint operacional executado por agendador externo/cron. |
| `/api/flows/end-run` | POST | supabase.auth.getUser | - | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/flows/import` | POST | guardRole (guardFlow) | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/flows/templates` | GET | guardRole (guardFlow) | admin | não | sim (via RLS) | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/inbox/conversations` | GET | getCurrentAccount | agent | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/inbox/counts` | GET | getCurrentAccount | agent | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/intelligence/chat` | POST | getCurrentAccount (currentIntelligenceScope) | supervisor | sim | sim | sim (checkRateLimit) | zod | Chat de IA com streaming NDJSON e execução de ferramentas. |
| `/api/intelligence/chats` | GET | getCurrentAccount (currentIntelligenceScope) | supervisor | sim | sim | não | não (GET) | Chat de IA com streaming NDJSON e execução de ferramentas. |
| `/api/intelligence/chats/[id]` | GET | getCurrentAccount (currentIntelligenceScope) | supervisor | sim | parcial | não | não (GET) | Chat de IA com streaming NDJSON e execução de ferramentas. |
| `/api/intelligence/tools` | GET | getCurrentAccount (currentIntelligenceScope) | supervisor | não | sim (via RLS) | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/intelligence/tools/[name]` | POST | getCurrentAccount (currentIntelligenceScope) | supervisor | não | sim (via RLS) | não | zod | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/invitations/[token]/peek` | GET | nenhuma (token na URL) | - | não | não (pública/global) | sim (checkRateLimit) | não (GET) | Página pública de convite (join); token na URL verificado via hash e RPC. |
| `/api/invitations/[token]/redeem` | POST | supabase.auth.getUser (token na URL) | - | não | parcial | sim (checkRateLimit) | não | Resgate de convite por usuário autenticado via token na URL. |
| `/api/invitations/redeem-by-code` | POST | supabase.auth.getUser | - | não | parcial | sim (checkRateLimit) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/lines` | GET | getCurrentAccount | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/mcp` | POST | requireApiKey (pessoal/intelligence) | supervisor | sim | sim | sim (checkRateLimit) | zod (MCP SDK) | Servidor MCP do DDM Intelligence (stateless Streamable HTTP), chave pessoal. |
| `/api/meta/webhook` | GET, POST | GET: verify_token; POST: HMAC (x-hub-signature-256) | - | não | não | não | zod | Webhook Meta Social (Instagram/Messenger) com verificação de assinatura HMAC. |
| `/api/monitoramento/conversations` | GET | requireRole | supervisor | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/monitoramento/dia` | GET | requireRole | supervisor | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/monitoramento/sla` | GET | requireRole | supervisor | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/relatorios/exports` | POST, DELETE | requireRole | supervisor/admin | sim (e ctx.supabase) | sim | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/settings/agents` | GET, POST | guardRole (agentRoute) | supervisor/admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/settings/agents/[id]` | GET, PATCH, DELETE | guardRole (agentRoute) | supervisor/admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/settings/agents/[id]/rollback` | POST | guardRole (agentRoute) | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/settings/agents/[id]/versions` | POST | guardRole (agentRoute) | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/settings/agents/preview` | POST | guardRole (agentRoute) | supervisor | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/settings/secrets` | GET, POST | guardRole | supervisor/admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/settings/secrets/[id]` | PATCH, DELETE | guardRole | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/settings/tools` | GET, POST | guardRole | supervisor/admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/settings/tools/[id]` | PATCH, DELETE | guardRole | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/settings/tools/[id]/test` | POST | guardRole | admin | sim | sim | sim (checkRateLimit) | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/stress/run` | POST | requireApiKey, x-cron-secret, HMAC | - | sim | sim | não | não | Acesso com service role filtrando estritamente account_id. |
| `/api/tags` | GET | getCurrentAccount | agent | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/telemetry` | POST | getCurrentAccount | agent | sim (e ctx.supabase) | sim | não | manual | Acesso escopado à conta do usuário autenticado. |
| `/api/v1/disparador/campaigns` | POST | requireApiKey | - | sim | sim | sim (checkRateLimit) | zod | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/v1/disparador/campaigns/[id]` | GET | requireApiKey | - | sim | sim | sim (checkRateLimit) | não (GET) | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/v1/me` | GET | requireApiKey | - | não | parcial | sim (checkRateLimit) | não (GET) | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/v1/openapi.json` | GET | nenhuma | - | não | não (pública/global) | não | não (GET) | Especificação pública OpenAPI 3.1 da API v1. |
| `/api/v1/reports/agents` | GET | requireApiKey | - | não | parcial | sim (checkRateLimit) | não (GET) | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/v1/reports/operations/current` | GET | requireApiKey | - | não | parcial | sim (checkRateLimit) | não (GET) | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/v1/reports/operations/summary` | GET | requireApiKey | - | não | parcial | sim (checkRateLimit) | não (GET) | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/v1/reports/tabulations` | GET | requireApiKey | - | não | parcial | sim (checkRateLimit) | não (GET) | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/v1/reports/teams` | GET | requireApiKey | - | não | parcial | sim (checkRateLimit) | não (GET) | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/v1/whatsapp/send` | POST | requireApiKey | - | não | sim | sim (checkRateLimit) | manual | Endpoint da API pública v1 autenticado por Bearer token de API key. |
| `/api/webchat/[token]` | GET | requireActiveSession (token) | - | sim | sim | não | não (GET) | Sessão pública de Webchat cliente validada por token da URL. |
| `/api/webchat/[token]/media` | GET | requireActiveSession (token) | - | sim | sim (session.account_id) | não | não (GET) | Sessão pública de Webchat cliente validada por token da URL. |
| `/api/webchat/[token]/messages` | GET, POST | requireActiveSession (token) | - | sim | sim | sim (429 manual) | zod | Sessão pública de Webchat cliente validada por token da URL. |
| `/api/webchat/[token]/open` | POST | requireActiveSession (token) | - | não | sim (session.account_id) | não | não | Sessão pública de Webchat cliente validada por token da URL. |
| `/api/webchat/[token]/upload` | POST | requireActiveSession (token) | - | sim | sim (session.account_id) | sim (429 manual) | manual | Sessão pública de Webchat cliente validada por token da URL. |
| `/api/webchat/settings` | GET, PUT | requireRole | admin | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/whatsapp/channel-test` | POST | guardRole | admin | não | sim | sim (checkRateLimit) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/channel-test/templates` | GET | guardRole | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/config` | GET, POST, DELETE, PATCH | getCurrentAccount, HMAC | agent | sim | sim | não | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/whatsapp/config/verify-registration` | GET | supabase.auth.getUser | - | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/contacts/avatar` | GET | getCurrentAccount | agent | sim | sim | não | não (GET) | Acesso com service role filtrando estritamente account_id. |
| `/api/whatsapp/contacts/sync-avatars` | POST | guardRole | admin | sim | sim | não | não | Acesso com service role filtrando estritamente account_id. |
| `/api/whatsapp/external-urls` | GET | nenhuma | - | não | não (pública/global) | não | não (GET) | Retorna URLs públicas de integrações externas (variáveis de ambiente). |
| `/api/whatsapp/media/[mediaId]` | GET | supabase.auth.getUser | - | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/react` | POST | guardRole | agent | não | sim | sim (checkRateLimit) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/send` | POST | guardRole | agent | sim | sim | sim (checkRateLimit) | manual | Acesso com service role filtrando estritamente account_id. |
| `/api/whatsapp/templates/[id]` | PATCH, DELETE | guardRole | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/templates/folders` | GET, POST | requireRole | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/templates/folders/[id]` | PATCH, DELETE | requireRole | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/templates/reorder` | POST | requireRole | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/templates/submit` | POST | guardRole | admin | não | sim | sim (429 manual) | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/templates/sync` | POST | guardRole | admin | não | sim | não | não | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/voip-url` | GET | getCurrentAccount | agent | não | sim (via RLS) | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/waha/pairing-code` | POST | guardRole | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/waha/qr` | GET | guardRole | admin | não | sim | não | não (GET) | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/waha/start` | POST | guardRole | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/waha/stop` | POST | guardRole | admin | não | sim | não | manual | Acesso via cliente de sessão com RLS ativo no Supabase. |
| `/api/whatsapp/webhook` | GET, POST | GET: verify_token; POST: HMAC (x-hub-signature-256) | - | sim | sim | não | zod | Webhook Meta Cloud API do WhatsApp com verificação de assinatura HMAC. |
| `/api/whatsapp/webhook/waha` | POST | HMAC (x-webhook-secret) | - | sim | sim | não | manual | Webhook WAHA com verificação de x-webhook-secret (HMAC por canal). |
