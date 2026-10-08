# Variáveis de ambiente (`.env`) — só o essencial da plataforma

Gerado a partir do PRD 19 (seção 6.1, 6.4 e 6.6). O CRM é uma **plataforma para outras empresas**: configuração de cliente
(chaves de LLM, token da DDM, UTM, links) fica **no banco, por conta, pela tela**. O `.env` guarda só o que é da
infraestrutura da plataforma. O modelo de produção está em [`.env.production.example`](../.env.production.example).

Regras gerais:

- `NEXT_PUBLIC_*` é embutida no **build** (`npm run build`): precisa estar no ambiente de build, não só no runtime.
- Depois de mudar qualquer valor: `touch tmp/restart.txt`.
- Segredos só em variável de ambiente do servidor/EasyPanel — nunca no repositório, em log ou em resposta de API.

## 1. Essenciais (obrigatórias)

| Variável | Para quê | Observação |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto Supabase | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave pública (cliente/SSR) | |
| `SUPABASE_SERVICE_ROLE_KEY` | operações privilegiadas de servidor | ignora RLS; nunca em código de cliente |
| `ENCRYPTION_KEY` | AES-256-GCM dos segredos gravados no banco | 64 caracteres hex; trocar orfana o que foi cifrado antes |
| `NEXT_PUBLIC_APP_URL` | URL pública do app (esquema + host, sem barra final) | única origem do host dos **links de convite** e do webhook WAHA; ver seção 5 |
| `CRON_SECRET` | protege os crons do Disparador (`/api/disparador/*`) | `openssl rand -hex 32` |
| `AUTOMATION_CRON_SECRET` | protege `/api/automations/cron` e `/api/flows/cron` | |
| `AUDIT_HEADER_SECRET` | assina os headers de auditoria | ≥ 32 caracteres; mesmo valor de `wacrm.audit_secrets` |
| `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | app da Meta **da plataforma** (Instagram/Messenger, verificação) | o WhatsApp de cada cliente usa o `app_secret` do **próprio canal** (cifrado no banco) |

## 2. Opcionais de infraestrutura

| Variável | Quando | Observação |
|---|---|---|
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | se usar Instagram | |
| `WAHA_WEBHOOK_SECRET` | se usar canais WAHA | segredo **mestre** do HMAC por canal; nunca vai ao WAHA; trocar = reiniciar as sessões |
| `STRESS_RUN_SECRET` | se mantiver o health check `/api/stress/run` | |
| `SSRF_ALLOWED_HOSTS` | só se precisar liberar host interno | segurança da plataforma: o cliente nunca libera rede interna |
| `DISPARADOR_CHAIN_URL` | tick encadeado do Disparador | origem usada para chamar o próprio app (loopback evita o proxy) |
| `VOIP_URL`, `VOIP_SERVICE_SECRET` | se usar chamadas (serviço Go) | nunca com prefixo `NEXT_PUBLIC_` |
| `NEXT_DEPLOYMENT_ID`, `PORT` | infraestrutura | sem `NEXT_DEPLOYMENT_ID`, usa o SHA do commit |
| `DISPARADOR_URL` | lido por `/api/whatsapp/external-urls` | opcional; está em revisão para sair do `.env` (link por conta) |
| `ALLOWED_INVITE_HOSTS` | alternativa à URL do app para convites | ver seção 5 |

## 3. Flags temporárias de implantação

Padrão desligado. Cada uma tem **critério e destino**: cumprido o critério, o padrão vira "ligado" e a variável **sai**.

| Flag | Padrão | Remover quando | Depois |
|---|---|---|---|
| `DISPARADOR_TICK_CHAIN` | desligada | proxy com timeout ≥ 60 s confirmado + 1 semana de `cron_tick` sem estourar o orçamento | vira padrão ligado; a env some |
| `DISPARADOR_BATCH_CLAIM` | desligada | validada em Postgres real na bancada e migration 188 aplicada | vira padrão ligado |
| `DISPARADOR_PREPARE_IN_TICK` | ligada | agendador externo chamando `/api/disparador/prepare/cron` | ramo no tick apagado |
| `WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET` | desligada | todas as sessões WAHA reiniciadas com `?channel=` | ramo legado apagado |
| `WHATSAPP_MESSAGE_INBOX` (`off`/`shadow`/`on`) | `off` | `shadow` sem divergência por 3–7 dias | vira padrão `on`; env removida |
| `FLOWS_CRON_V2` | desligada | migration 210 aplicada e validada | vira padrão ligado; env removida |

## 4. Nunca em produção

Variáveis de teste e bancada. O gate de `src/instrumentation.ts` aborta o boot se forem usadas contra a Meta real ou o
Supabase de produção.

| Variável | Regra |
|---|---|
| `DISPATCH_LOAD_TEST`, `LOAD_*`, `MOCK_*`, `IMPORT_LOAD_*`, `METRICS_LOAD_INCREMENTS` | só em staging/bancada |
| `META_API_BASE_URL`, `OPENAI_BASE_URL` | só valem com `DISPATCH_LOAD_TEST=1`; **sem a flag são ignoradas** (a OpenAI usa sempre a base real, inclusive no SDK oficial) |
| `WHATSAPP_TEMPLATES_DRY_RUN` | **ignorada quando `NODE_ENV=production`** (aviso no log): não pode gerar template sintético em produção |
| `RUN_LIVE_LLM`, `LIVE_LLM_PROVIDER`, `STRESS_API_KEY`, `LOAD_API_KEY`, `SUPABASE_URL` | testes/scripts |

## 5. Links de convite (falha fechado)

O link de convite carrega um token de acesso à conta; o host dele **só** vem de configuração do servidor:

1. `NEXT_PUBLIC_APP_URL` (alias legado: `NEXT_PUBLIC_SITE_URL`) — vence sempre.
2. `ALLOWED_INVITE_HOSTS` (`host[:porta]`, separados por vírgula) — com um host, ele é usado; com vários, a requisição só
   **escolhe** entre os da lista (o link sai com o texto da lista, nunca com o do cabeçalho `Host`). Host fora da lista → erro.
3. Nenhuma das duas → `POST /api/account/invitations` responde **500** com mensagem clara, antes de criar o convite.

O cabeçalho `Host`/`X-Forwarded-Host` da requisição e o domínio `wacrm.tech` **não** são mais usados como padrão.

## 6. O que NÃO é mais variável de ambiente (cliente → tela, por conta)

| Antes (env) | Destino |
|---|---|
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `CLAUDE_API_KEY`/`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `DISPARADOR_OPENAI_API_KEY` | cofre da conta (chave de provedor) |
| `DDM_ACORDOS_API_TOKEN` (aliases `DDM_TOKEN`, `DDM_API_KEY`) | cofre da conta; o **nome** do marcador `{{secret.DDM_TOKEN}}` permanece |
| `UTM_API_KEY` | cofre da conta |
| `LEAD_EXTRACTOR_URL` | configuração da conta |
| Ajustes de desempenho (`DISPATCH_PROCESS_CONCURRENCY`, `DISPARADOR_AUTO_PAUSE*`, `AI_LLM_*`, `AI_STALL_*`, `META/WAHA_TIMEOUT_MS`…) | `platform_config` (banco, auditado) — fase 19.2 do PRD 19; até lá continuam lidas do `.env` |

Enquanto a migração por conta não termina (fases 19.3–19.4 do PRD 19), as variáveis de cliente acima ainda funcionam como
fallback: **não as remova do servidor sem antes cadastrar o valor pela tela**.

## 7. Removidas dos exemplos

`DDM_LOGS_USER` e `DDM_LOGS_PASSWORD` (confirmado por busca no repositório: nenhum código lê). **Mantidas** nos exemplos
da aplicação: `DISPATCH_SINGLE_ACCOUNT_ID` (lida pelo serviço legado em `disparador/backend`) e `DISPARADOR_URL` (lida por
`/api/whatsapp/external-urls`) — a regra é só remover o que nenhum código lê; nenhuma das duas entra no
`.env.production.example`.
