# Inventário de Variáveis de Ambiente — CRM-DDM (Branch `v2`)

Inventário mecânico de todas as **117 variáveis de ambiente** lidas em `src/**`, `scripts/**` e declaradas em `.env.local.example`.

Colunas: `variável | arquivos que leem (até 3) | tem valor padrão no código? qual | para que serve (1 frase, do código/comentário) | é segredo? (sim/não) | tipo sugerido`

- **INFRA** = essencial da plataforma (banco/Supabase, ENCRYPTION_KEY, CRON_SECRET, URL do app, NODE_ENV…);
- **CLIENTE** = configuração ou credencial de um cliente/conta (ex.: token de API de um parceiro, app id de Instagram, chave de UTM, número, verify token de webhook);
- **AJUSTE** = parâmetro de desempenho/operação (concorrência, timeouts, orçamento do tick, limites);
- **FLAG** = liga/desliga de implantação (ex.: DISPARADOR_BATCH_CLAIM, DISPARADOR_TICK_CHAIN, DISPATCH_LOAD_TEST);
- **?** = não dá para saber pelo código.

| variável | arquivos que leem (até 3) | tem valor padrão no código? qual | para que serve (1 frase, do código/comentário) | é segredo? (sim/não) | tipo sugerido |
| --- | --- | --- | --- | --- | --- |
| `ALLOWED_INVITE_HOSTS` | `src/app/api/account/invitations/route.ts` | não (usa host da requisição ou wacrm.tech) | Lista de hostnames permitidos para URLs de convite de conta (/api/account/invitations) | não | **INFRA** |
| `AUDIT_HEADER_SECRET` | `src/lib/audit/context.ts`, `src/lib/audit/audit.test.ts` | não | Segredo compartilhado (mínimo 32 chars) para assinar headers de auditoria do cliente SSR | sim | **INFRA** |
| `AUTOMATION_CRON_SECRET` | `src/app/api/automations/cron/route.ts`, `src/app/api/channels/refresh-tokens/route.ts`, `src/app/api/conversations/retry-assignment/route.ts` | não | Segredo compartilhado que autoriza a rota de cron de automações (/api/automations/cron) | sim | **INFRA** |
| `CRON_SECRET` | `src/app/api/disparador/campaigns/[id]/start/route.ts`, `src/app/api/disparador/cron/route.ts`, `src/app/api/disparador/health/cron/route.ts` | não | Segredo compartilhado para autorizar chamadas dos crons do disparador e de health | sim | **INFRA** |
| `DDM_LOGS_PASSWORD` | .env.local.example | não (definido em .env.local.example) | Senha de autenticação básica administrativa para /ddm-logs (legado/suporte) | sim | **INFRA** |
| `DDM_LOGS_USER` | .env.local.example | não (definido em .env.local.example) | Usuário de autenticação básica administrativa para /ddm-logs (legado/suporte) | não | **INFRA** |
| `DISPARADOR_CHAIN_URL` | `src/lib/disparador/tick-chain.ts`, `src/app/api/disparador/cron/route.test.ts` | sim: fallback para NEXT_PUBLIC_APP_URL | Origem HTTP base usada pelo cron do disparador para disparar o próximo hop da cadeia | não | **INFRA** |
| `DISPARADOR_URL` | `src/app/api/whatsapp/external-urls/route.ts` | sim: '' | URL externa do serviço disparador exposta na rota /api/whatsapp/external-urls | não | **INFRA** |
| `DISPATCH_SINGLE_ACCOUNT_ID` | .env.local.example | não (definido em .env.local.example) | ID da conta única do CRM atendida pelo backend legado de disparo (disparador/) | não | **INFRA** |
| `ENCRYPTION_KEY` | `src/lib/channels/oauth.ts`, `src/lib/whatsapp/encryption.ts`, `scripts/encrypt-plaintext-app-secrets.mjs` | não | Chave AES-256-GCM de 64 caracteres hexadecimais para criptografia de tokens e credenciais | sim | **INFRA** |
| `LEAD_EXTRACTOR_URL` | `src/app/api/whatsapp/external-urls/route.ts` | sim: 'https://grupoddmlead.lovable.app' | URL do extrator de leads exposta para redirecionamento no frontend | não | **INFRA** |
| `LOAD_ACCOUNT_ID` | `scripts/loadtest/lib/load-metrics.mjs` | não | ID da conta do CRM usada para receber dados gerados na bancada de carga | não | **INFRA** |
| `LOAD_APP_SECRET` | `scripts/loadtest/load.mjs` | não | Segredo do app usado para autenticar scripts de teste de carga contra a API | sim | **INFRA** |
| `LOAD_APP_URL` | `scripts/loadtest/lib/load-metrics.mjs` | não | URL base da instância do aplicativo sob teste de carga | não | **INFRA** |
| `LOAD_CRON_SECRET` | `scripts/loadtest/lib/load-metrics.mjs` | não | CRON_SECRET correspondente à aplicação em teste para acionar o endpoint de cron | sim | **INFRA** |
| `LOAD_MOCK_STATS_URL` | `scripts/loadtest/lib/load-metrics.mjs` | sim: 'http://127.0.0.1:4010' | Endereço do endpoint de estatísticas da Meta simulada nos testes de carga | não | **INFRA** |
| `LOAD_SUPABASE_SERVICE_ROLE_KEY` | `scripts/loadtest/lib/load-metrics.mjs` | não | Service role key do Supabase de teste utilizado pela bancada de carga | sim | **INFRA** |
| `LOAD_SUPABASE_URL` | `scripts/loadtest/lib/load-metrics.mjs` | não | URL do projeto Supabase de teste utilizado pela bancada de carga | não | **INFRA** |
| `LOAD_USER_ID` | `scripts/loadtest/lib/load-metrics.mjs` | não | ID do usuário do CRM associado aos recursos criados pela bancada de carga | não | **INFRA** |
| `META_API_BASE_URL` | `src/lib/loadtest/gate.ts` | sim: 'https://graph.facebook.com' (só aceita override com DISPATCH_LOAD_TEST=1) | URL base da Graph API da Meta (usada para direcionar requisições ao simulador mock) | não | **INFRA** |
| `MOCK_APP_SECRET` | `scripts/loadtest/mock-meta.mjs` | sim: 'mock-meta-secret' | App secret fictício para cálculo de assinaturas no simulador mock-meta | sim | **INFRA** |
| `MOCK_HOST` | `scripts/loadtest/mock-meta.mjs` | sim: '127.0.0.1' | Host de bind do servidor simulador mock-meta | não | **INFRA** |
| `MOCK_PORT` | `scripts/loadtest/mock-meta.mjs` | sim: 4010 | Porta TCP do servidor simulador mock-meta | não | **INFRA** |
| `MOCK_WABA_ID` | `scripts/loadtest/mock-meta.mjs` | sim: 'mock-waba-default' | ID simulado da WABA retornado pelo mock-meta | não | **INFRA** |
| `MOCK_WEBHOOK_URL` | `scripts/loadtest/mock-meta.mjs` | sim: '' | URL de destino para disparo de webhooks de status pelo servidor mock-meta | não | **INFRA** |
| `NEXT_PUBLIC_APP_URL` | `src/app/api/stress/run/route.ts`, `src/app/api/v1/openapi.json/route.ts`, `src/app/api/webchat/settings/route.ts` | não (com fallbacks contextuais em certas rotas) | URL pública canônica do app para links de Webchat, callbacks OAuth e webhooks | não | **INFRA** |
| `NEXT_PUBLIC_SITE_URL` | `src/app/api/account/invitations/route.ts`, `src/lib/whatsapp/waha-webhook-auth.ts`, `src/lib/whatsapp/waha-webhook-auth.test.ts` | sim: 'https://wacrm.tech' ou origin da requisição | URL base pública canônica usada para sitemap, OG images e links de convite de conta | não | **INFRA** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `src/app/auth/callback/route.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts` | não | Chave pública anônima do Supabase para acesso client-side sujeito a RLS | não | **INFRA** |
| `NEXT_PUBLIC_SUPABASE_URL` | `src/app/api/account/ai-config/route.ts`, `src/app/api/ddm-logs/route.ts`, `src/app/api/feedback/route.ts` | não | URL do projeto Supabase para comunicação da API e banco de dados | não | **INFRA** |
| `NEXT_RUNTIME` | `src/instrumentation.ts` | sim: 'nodejs' (pelo runtime do Next.js) | Identifica o runtime de execução atual no Next.js (Node.js vs Edge) | não | **INFRA** |
| `NODE_ENV` | `src/lib/loadtest/gate.test.ts` | sim: 'development' (ou 'production' em builds) | Ambiente de execução padrão do Node.js (development / production / test) | não | **INFRA** |
| `OPENAI_BASE_URL` | `src/lib/loadtest/gate.ts` | sim: 'https://api.openai.com' (só aceita override com DISPATCH_LOAD_TEST=1) | URL base para chamadas à OpenAI (permite apontar para simulador na bancada de carga) | não | **INFRA** |
| `SSRF_ALLOWED_HOSTS` | `src/lib/ai/agents/convert.ts`, `src/lib/ai/agents/service.ts`, `src/lib/security/ssrf-guard.ts` | sim: '' (nenhum host privado permitido por padrão) | Lista separada por vírgula de hosts internos permitidos no guard anti-SSRF | não | **INFRA** |
| `STRESS_RUN_SECRET` | `src/app/api/stress/run/route.ts` | não | Segredo compartilhado que protege o endpoint de health check automatizado POST /api/stress/run | sim | **INFRA** |
| `SUPABASE_SERVICE_ROLE_KEY` | `src/app/api/account/ai-config/route.ts`, `src/app/api/ddm-logs/route.ts`, `src/app/api/feedback/route.ts` | não | Chave service-role do Supabase com bypass de RLS para operações de servidor | sim | **INFRA** |
| `SUPABASE_URL` | `src/lib/loadtest/gate.ts`, `src/lib/loadtest/gate.test.ts` | sim: fallback para NEXT_PUBLIC_SUPABASE_URL | URL alternativa do Supabase validada pelo gate da bancada de carga | não | **INFRA** |
| `VOIP_SERVICE_SECRET` | `src/app/api/calls/[...path]/route.ts` | não | Segredo de autenticação das chamadas de servidor para o microserviço VoIP | sim | **INFRA** |
| `VOIP_URL` | `src/app/api/calls/[...path]/route.ts` | sim: 'http://127.0.0.1:8080' (.env.local.example) | URL base do serviço Go de VoIP para chamadas de áudio | não | **INFRA** |
| `ANTHROPIC_API_KEY` | `src/lib/ai/llm-shared.ts`, `src/lib/ai/responder.ts`, `src/lib/flows/simulator/ai.ts` | não | Chave de API da Anthropic para agentes de IA (alternativa a CLAUDE_API_KEY) | sim | **CLIENTE** |
| `CLAUDE_API_KEY` | `src/lib/ai/llm-shared.ts`, `src/lib/ai/responder.ts`, `src/lib/flows/simulator/ai.ts` | não | Chave de API do Claude (Anthropic) para execução de agentes de inteligência artificial | sim | **CLIENTE** |
| `DDM_ACORDOS_API_TOKEN` | `src/lib/ai/responder.ts` | não | Token da API DDM Acordos para consulta de débitos por CPF e formalização de acordo pela IA | sim | **CLIENTE** |
| `DDM_API_KEY` | `src/lib/ai/responder.ts` | não (alias legado de DDM_ACORDOS_API_TOKEN) | Nome alternativo para DDM_ACORDOS_API_TOKEN mantido para compatibilidade | sim | **CLIENTE** |
| `DDM_TOKEN` | `src/lib/ai/responder.ts` | não (alias legado de DDM_ACORDOS_API_TOKEN) | Nome alternativo para DDM_ACORDOS_API_TOKEN mantido para compatibilidade | sim | **CLIENTE** |
| `DISPARADOR_OPENAI_API_KEY` | `src/lib/disparador/dispatch-ai.ts` | sim: fallback para OPENAI_API_KEY | Chave da OpenAI exclusiva para envios do tipo 'ia' do disparador | sim | **CLIENTE** |
| `GEMINI_API_KEY` | `src/lib/ai/llm-shared.ts`, `src/lib/ai/responder.ts`, `src/lib/flows/simulator/ai.ts` | não | Chave de API do Google Gemini para execução dos agentes de IA | sim | **CLIENTE** |
| `INSTAGRAM_APP_ID` | `src/lib/channels/oauth.ts` | não | App ID do aplicativo Meta para autenticação OAuth com Instagram Login | não | **CLIENTE** |
| `INSTAGRAM_APP_SECRET` | `src/app/api/meta/webhook/route.ts`, `src/lib/channels/oauth.ts` | não | App Secret do aplicativo Meta para troca de código OAuth e validação de tokens do Instagram | sim | **CLIENTE** |
| `LOAD_API_KEY` | `scripts/loadtest/lib/load-metrics.mjs` | sim: '' | Chave de API pública usada nos testes de carga de disparador | sim | **CLIENTE** |
| `META_APP_ID` | `src/lib/channels/oauth.ts`, `src/lib/whatsapp/template-header-handle.ts`, `src/lib/whatsapp/template-header-handle.test.ts` | não | App ID da Meta exigido para upload de cabeçalhos de mídia de templates e OAuth do Messenger | não | **CLIENTE** |
| `META_APP_SECRET` | `src/app/api/meta/webhook/route.ts`, `src/app/api/stress/run/route.ts`, `src/app/api/whatsapp/config/route.ts` | não | Meta App Secret usado para validar assinatura HMAC-SHA256 dos webhooks e trocas OAuth | sim | **CLIENTE** |
| `META_WEBHOOK_VERIFY_TOKEN` | `src/app/api/channels/route.ts`, `src/app/api/meta/webhook/route.ts` | não | Token de verificação exigido pela Meta na validação inicial do webhook (GET /api/meta/webhook) | sim | **CLIENTE** |
| `OPENAI_API_KEY` | `src/app/api/intelligence/chat/route.ts`, `src/lib/ai/llm-shared.ts`, `src/lib/ai/responder.ts` | não | Chave de API da OpenAI para geração de texto, chat analítico e transcrição de áudio (STT) | sim | **CLIENTE** |
| `OPENROUTER_API_KEY` | `src/lib/ai/llm-shared.ts`, `src/lib/ai/responder.ts`, `src/lib/flows/simulator/ai.ts` | não | Chave de API do OpenRouter para roteamento e acesso a múltiplos modelos de IA | sim | **CLIENTE** |
| `STRESS_API_KEY` | `src/app/api/stress/run/route.ts` | não | Chave de API pública usada pelo teste automatizado 12 de campanhas em /api/stress/run | sim | **CLIENTE** |
| `UTM_API_KEY` | `src/app/api/disparador/utm/metricas/route.ts`, `src/app/api/disparador/utm/route.ts` | não | Chave da API externa do UTMPay para encurtamento e rastreamento de links em lote | sim | **CLIENTE** |
| `WAHA_WEBHOOK_SECRET` | `src/app/api/whatsapp/webhook/waha/route.ts`, `src/lib/whatsapp/waha-webhook-auth.ts`, `src/app/api/whatsapp/webhook/waha/route.test.ts` | não | Segredo mestre para assinar e validar webhooks recebidos de instâncias WAHA | sim | **CLIENTE** |
| `AI_KB_MAX_CHARS` | `src/lib/ai/agents/convert.ts`, `src/lib/ai/kb-context.ts`, `src/lib/ai/kb-context.test.ts` | sim: 12000 (knowledge.max_chars) | Teto de caracteres do contexto da base de conhecimento (KB) injetado no prompt da IA | não | **AJUSTE** |
| `AI_LLM_429_MAX_RETRIES` | `src/lib/ai/agents/convert.ts`, `src/lib/ai/llm-gate.ts`, `src/lib/ai/llm-gate.test.ts` | sim: 2 (execution.rate_limit_retries) | Número máximo de retentativas ao receber HTTP 429 (rate limit) de provedor de LLM | não | **AJUSTE** |
| `AI_LLM_429_MAX_WAIT_MS` | `src/lib/ai/agents/convert.ts`, `src/lib/ai/llm-gate.ts` | sim: 8000 (8s) | Tempo máximo de espera (ms) em backoff antes de retentar após HTTP 429 da LLM | não | **AJUSTE** |
| `AI_LLM_MAX_CONCURRENCY` | `src/lib/ai/agents/convert.ts`, `src/lib/ai/llm-gate.ts`, `src/lib/ai/llm-gate.test.ts` | sim: 20 (execution.concurrency) | Semáforo de concorrência máxima de chamadas simultâneas a LLMs por processo | não | **AJUSTE** |
| `AI_LLM_QUEUE_MAX_WAIT_MS` | `src/lib/ai/agents/convert.ts`, `src/lib/ai/llm-gate.ts` | sim: 60000 (60s) | Tempo máximo de espera na fila do semáforo de LLM antes de descartar a requisição | não | **AJUSTE** |
| `AI_STALL_MAX_MINUTES` | `src/lib/ai/agents/convert.ts`, `src/lib/flows/ai-watchdog.ts` | sim: 30 (30 min) | Janela máxima desde a última mensagem do cliente para considerar resposta da IA travada | não | **AJUSTE** |
| `AI_STALL_SECONDS` | `src/lib/ai/agents/convert.ts`, `src/lib/flows/ai-watchdog.ts` | sim: 180 (3 min) | Tempo de silêncio sem resposta da IA antes de acionar o watchdog de IA travada (handoff) | não | **AJUSTE** |
| `DISPARADOR_131026_CONFIRM_MINUTES` | `src/app/api/disparador/cron/route.ts` | sim: 1440 (24 horas) | Janela em minutos sem recibo para erro temporário 131026 da Meta virar erro definitivo | não | **AJUSTE** |
| `DISPARADOR_ASSUMED_P95_S` | `src/app/api/disparador/cron/route.ts` | sim: 1 (máx. 30) | Latência p95 presumida da Meta em segundos para derivar vagas de envio do limite/s | não | **AJUSTE** |
| `DISPARADOR_AUTO_PAUSE_ERROR_RATE` | `src/lib/disparador/auto-pause.ts` | sim: 0.15 (15%) | Taxa mínima de erro permanente na janela para disparar auto-pausa da campanha | não | **AJUSTE** |
| `DISPARADOR_AUTO_PAUSE_MIN_ATTEMPTS` | `src/lib/disparador/auto-pause.ts`, `src/app/api/disparador/cron/route.test.ts` | sim: 20 | Volume mínimo de tentativas na janela para habilitar o cálculo de auto-pausa | não | **AJUSTE** |
| `DISPARADOR_AUTO_PAUSE_UNCERTAIN_COUNT` | `src/lib/disparador/auto-pause.ts` | sim: 3 | Contagem consecutiva de desfechos incertos (5xx/timeout) necessária para auto-pausa | não | **AJUSTE** |
| `DISPARADOR_AUTO_PAUSE_UNCERTAIN_WINDOW_SECONDS` | `src/lib/disparador/auto-pause.ts` | sim: 60 | Janela de tempo em segundos para monitoramento de desfechos incertos consecutivos | não | **AJUSTE** |
| `DISPARADOR_AUTO_PAUSE_WINDOW` | `src/lib/disparador/auto-pause.ts` | sim: 50 | Tamanho da janela deslizante de itens recentes avaliados para auto-pausa | não | **AJUSTE** |
| `DISPARADOR_BACKOFF_COOLDOWN_SECONDS` | `src/lib/disparador/throughput-config.ts` | sim: 300 (5 min) | Duração do cooldown em segundos após rate limit explícito antes de restaurar concorrência | não | **AJUSTE** |
| `DISPARADOR_MAX_EVENT_LOOP_LAG_MS` | `src/lib/disparador/throughput-config.ts` | sim: 200 (clamped 20..10000) | Teto de lag do event loop p99 em ms acima do qual o disparador reduz concorrência | não | **AJUSTE** |
| `DISPARADOR_MAX_RSS_MB` | `src/lib/disparador/throughput-config.ts` | sim: 1024 (clamped 128..65536) | Teto de consumo de memória RSS em MB acima do qual o disparador reduz concorrência | não | **AJUSTE** |
| `DISPARADOR_PER_NUMBER_CONCURRENCY` | `src/lib/disparador/throughput-config.ts` | sim: 4 (DB_DEFAULT_MAX_IN_FLIGHT, clamped 1..150) | Concorrência máxima genérica de envios simultâneos por número de WhatsApp | não | **AJUSTE** |
| `DISPARADOR_PER_NUMBER_CONCURRENCY_META` | `src/lib/disparador/throughput-config.ts` | sim: herda DISPARADOR_PER_NUMBER_CONCURRENCY (padrão 4) | Concorrência máxima específica por número para o provedor oficial Meta Cloud API | não | **AJUSTE** |
| `DISPARADOR_PER_NUMBER_CONCURRENCY_WAHA` | `src/lib/disparador/throughput-config.ts` | sim: min(genérico, 4) | Concorrência máxima específica por número para sessões WAHA (teto de segurança 50) | não | **AJUSTE** |
| `DISPARADOR_PREPARE_BUDGET_MS` | `src/app/api/disparador/prepare/cron/route.ts` | sim: 240000 (4 min) | Orçamento de tempo em ms para execução de um tick de preparo de campanhas | não | **AJUSTE** |
| `DISPARADOR_TICK_BUDGET_MS` | `src/lib/disparador/throughput-config.ts`, `src/app/api/disparador/cron/route.test.ts` | sim: 35000 (ou 50000 se tick-chain ativo) | Orçamento de tempo em ms por tick do cron antes de cessar novos envios | não | **AJUSTE** |
| `DISPARADOR_TICK_CHAIN_MAINTENANCE_EVERY` | `src/lib/disparador/tick-chain.ts` | sim: 5 (a cada 5 hops) | Frequência de hops para execução de manutenção pesada na cadeia de ticks | não | **AJUSTE** |
| `DISPARADOR_TICK_CHAIN_MAX_HOPS` | `src/lib/disparador/tick-chain.ts`, `src/app/api/disparador/cron/route.test.ts` | sim: 90 | Número máximo de hops consecutivos permitidos em uma mesma cadeia de ticks | não | **AJUSTE** |
| `DISPARADOR_TICK_CHAIN_MAX_PER_MIN` | `src/lib/disparador/tick-chain.ts` | sim: 6 | Taxa máxima de hops encadeados por minuto permitida na cadeia do disparador | não | **AJUSTE** |
| `DISPATCH_OPENAI_TIMEOUT_MS` | `src/lib/disparador/dispatch-ai.ts` | sim: 30000 (30s, máx. 120s) | Timeout em ms para chamadas à OpenAI na geração de mensagens de campanha do tipo IA | não | **AJUSTE** |
| `DISPATCH_PROCESS_CONCURRENCY` | `src/lib/disparador/concurrency.ts`, `src/lib/disparador/throughput-config.ts`, `src/app/api/disparador/cron/route.test.ts` | sim: 4 (máx. 150) | Teto global de envios simultâneos em andamento no processo do cron do disparador | não | **AJUSTE** |
| `IMPORT_LOAD_BLOCK` | `src/app/api/disparador/contacts/import/route.load.test.ts` | sim: 1000 | Tamanho do bloco de linhas inseridas no banco durante o teste de carga de importação | não | **AJUSTE** |
| `IMPORT_LOAD_LATENCY_MS` | `src/app/api/disparador/contacts/import/route.load.test.ts` | sim: 0 | Latência artificial em ms injetada nas operações de banco no teste de carga de importação | não | **AJUSTE** |
| `IMPORT_LOAD_ROWS` | `src/app/api/disparador/contacts/import/route.load.test.ts` | sim: 3000 | Quantidade total de contatos importados no teste de carga de importação | não | **AJUSTE** |
| `INTELLIGENCE_DAILY_MAX_MESSAGES` | `src/lib/intelligence/chat/store.ts` | sim: 50 (se ausente/inválido) | Limite diário de perguntas ao assistente analítico (Intelligence Chat) por conta | não | **AJUSTE** |
| `INTELLIGENCE_MODEL` | `src/lib/intelligence/chat/openai-client.ts` | sim: 'gpt-4o-mini' | Identificador do modelo LLM utilizado no assistente analítico do dashboard | não | **AJUSTE** |
| `LIVE_LLM_PROVIDER` | `src/lib/ai/acordo-tagging.live.test.ts` | sim: 'openai' | Provedor de LLM utilizado na suíte de testes de validação ao vivo de tagging | não | **AJUSTE** |
| `LOAD_CAMPAIGNS_PER_CHANNEL` | `scripts/loadtest/lib/load-metrics.mjs` | sim: 1 (clamped 1..20) | Número de campanhas fictícias criadas por canal na bancada de carga | não | **AJUSTE** |
| `LOAD_CHANNELS` | `scripts/loadtest/lib/load-metrics.mjs` | sim: 3 (clamped 1..50) | Quantidade de canais fictícios criados para os testes de carga | não | **AJUSTE** |
| `LOAD_DURATION_S` | `scripts/loadtest/lib/load-metrics.mjs` | sim: 300 (5 min, clamped 10..21600) | Duração do teste de carga em segundos | não | **AJUSTE** |
| `LOAD_ITEMS` | `scripts/loadtest/lib/load-metrics.mjs` | sim: 5000 (clamped 1..20000) | Quantidade de itens criados por campanha fictícia na bancada de carga | não | **AJUSTE** |
| `LOAD_TICK_INTERVAL_MS` | `scripts/loadtest/lib/load-metrics.mjs` | sim: 2000 (clamped 0..60000) | Intervalo em ms entre acionamentos do cron durante a execução do teste de carga | não | **AJUSTE** |
| `META_API_VERSION` | `src/lib/whatsapp/meta-api.ts` | sim: 'v21.0' | Versão da Graph API da Meta utilizada pelo cliente meta-api.ts | não | **AJUSTE** |
| `META_GRAPH_VERSION` | `src/lib/channels/graph.ts` | sim: 'v25.0' | Versão da Graph API para chamadas de canais sociais (Instagram/Messenger) | não | **AJUSTE** |
| `META_TIMEOUT_MS` | `src/lib/whatsapp/meta-api.ts` | sim: 20000 (20s) | Timeout máximo em ms para requisições HTTP enviadas à Graph API da Meta | não | **AJUSTE** |
| `METRICS_LOAD_INCREMENTS` | `src/lib/disparador/campaign-metric-deltas.sql.test.ts` | sim: 10000 | Número de iterações em teste de carga de deltas de métricas de campanha | não | **AJUSTE** |
| `MOCK_ERRORS` | `scripts/loadtest/mock-meta.mjs` | sim: false (ou lista de erros) | Configuração de injeção de erros simulados no servidor mock-meta | não | **AJUSTE** |
| `MOCK_LATENCY_P50_MS` | `scripts/loadtest/mock-meta.mjs` | sim: 40 | Latência mediana simulada em ms no servidor mock-meta | não | **AJUSTE** |
| `MOCK_LATENCY_P95_MS` | `scripts/loadtest/mock-meta.mjs` | sim: 120 | Latência p95 simulada em ms no servidor mock-meta | não | **AJUSTE** |
| `MOCK_QUALITY_INTERVAL_MS` | `scripts/loadtest/mock-meta.mjs` | sim: 60000 | Intervalo em ms para envio de eventos de qualidade no simulador mock-meta | não | **AJUSTE** |
| `MOCK_READ_RATE` | `scripts/loadtest/mock-meta.mjs` | sim: 0.95 | Taxa simulada de recibos de leitura gerados pelo mock-meta | não | **AJUSTE** |
| `MOCK_TIMEOUT_HOLD_MS` | `scripts/loadtest/mock-meta.mjs` | sim: 35000 | Tempo de retenção em ms antes de estourar timeout simulado no mock-meta | não | **AJUSTE** |
| `WAHA_TIMEOUT_MS` | `src/lib/whatsapp/waha-api.ts` | sim: 15000 (15s) | Timeout máximo em ms para requisições HTTP enviadas à API do WAHA | não | **AJUSTE** |
| `AI_EXTERNAL_RAG_ENABLED` | `src/lib/ai/agents/external-rag.ts` | não (desligado por padrão, exige 'true') | Habilita conector opcional de RAG externo para agentes de IA | não | **FLAG** |
| `DISPARADOR_ADAPTIVE_BACKOFF` | `src/lib/disparador/throughput-config.ts` | sim: ligado (desliga com '0', 'false' ou 'off') | Habilita ou desabilita o backoff adaptativo de redução de concorrência por canal | não | **FLAG** |
| `DISPARADOR_AUTO_PAUSE` | `src/lib/disparador/auto-pause.ts` | sim: ligado ('on', desliga com 'off') | Habilita ou desabilita a pausa automática de campanhas sob taxa alta de erro | não | **FLAG** |
| `DISPARADOR_BATCH_CLAIM` | `src/lib/disparador/batch-claim.ts`, `src/app/api/disparador/cron/route.test.ts` | não (desligado por padrão; '1', 'true' ou 'on' liga) | Liga o claim em lote de itens no disparador (migration 188) | não | **FLAG** |
| `DISPARADOR_PREPARE_IN_TICK` | `src/lib/disparador/prepare-campaigns.ts`, `src/app/api/disparador/cron/route.test.ts` | sim: true (ligado por padrão; '0' ou 'false' desliga) | Controla se a rota do cron principal executa preparo de campanhas dentro do tick | não | **FLAG** |
| `DISPARADOR_TICK_CHAIN` | `src/lib/disparador/tick-chain.ts`, `src/app/api/disparador/cron/route.test.ts` | não (desligado por padrão; '1', 'true' ou 'on' liga) | Ativa o modo de tick encadeado (self-chaining) contínuo do disparador | não | **FLAG** |
| `DISPATCH_LOAD_TEST` | `src/lib/loadtest/gate.ts` | não (desligado por padrão; '1' ativa) | Trava de segurança que autoriza simulação da bancada de carga contra mocks locais | não | **FLAG** |
| `LOAD_ALLOW_REMOTE_APP` | `scripts/loadtest/lib/load-metrics.mjs` | não (exige 'true' se LOAD_APP_URL não for localhost) | Permite executar a bancada de carga contra host de app remoto não-privado | não | **FLAG** |
| `LOAD_CONFIRM_TEST_DB` | `scripts/loadtest/lib/load-metrics.mjs` | não (exige 'yes' para executar) | Confirmação explícita obrigatória de que o banco é de teste antes do seed/carga | não | **FLAG** |
| `RUN_LIVE_LLM` | `src/lib/ai/acordo-tagging.live.test.ts` | não (desligado por padrão, exige '1') | Flag para autorizar testes com chamadas reais a LLMs consumindo créditos externos | não | **FLAG** |
| `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET` | `src/lib/whatsapp/waha-webhook-auth.ts`, `src/app/api/whatsapp/webhook/waha/route.test.ts`, `src/lib/whatsapp/waha-webhook-auth.test.ts` | não (desligado por padrão, aceita 'true') | Permite aceitar segredo global legado de webhooks do WAHA durante migração | não | **FLAG** |
| `WHATSAPP_TEMPLATES_DRY_RUN` | `src/app/api/whatsapp/templates/[id]/route.ts`, `src/app/api/whatsapp/templates/submit/route.ts` | não (desligado por padrão, aceita 'true') | Ignora chamadas reais à Meta no envio de templates e gera IDs sintéticos (CI/dev) | não | **FLAG** |

## Resumo por Tipo

- **INFRA**: 38 variáveis
- **CLIENTE**: 18 variáveis
- **AJUSTE**: 49 variáveis
- **FLAG**: 12 variáveis
- **Total**: 117 variáveis
