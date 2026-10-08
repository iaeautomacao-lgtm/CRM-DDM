# Crons e rotinas agendadas

O app roda sob Phusion Passenger: `setInterval` e workers em memória **não sobrevivem a restart**.
Toda rotina recorrente é uma rota **stateless** chamada por um agendador externo (crontab do
cPanel/EasyPanel, ou outro pinger). Este documento lista todas as rotas desse tipo no código.

> **Frequência real em produção: A CONFIRMAR com o dono (crontab/EasyPanel).** A coluna
> "recomendada" abaixo sai dos comentários do código, não do que está agendado hoje. Antes de
> mudar qualquer coisa, comparar com o crontab real do servidor.

## Segredos

| Variável | Header | Rotas |
|---|---|---|
| `CRON_SECRET` | `x-cron-secret` | `/api/disparador/cron`, `/api/disparador/prepare/cron`, `/api/disparador/health/cron` |
| `AUTOMATION_CRON_SECRET` | `x-cron-secret` | `/api/automations/cron`, `/api/flows/cron`, `/api/channels/refresh-tokens`, `/api/conversations/retry-assignment` |
| `STRESS_RUN_SECRET` | `x-stress-secret` | `/api/stress/run` (manual, não é cron) |

Todas respondem **503** se a variável não estiver configurada (fail-closed) e **401** se o
segredo não bater (comparação em tempo constante). O segredo vai no header, nunca na URL.

## Rotas

| Rota | Método | Segredo | Recomendada | Orçamento de tempo | Se parar |
|---|---|---|---|---|---|
| `/api/disparador/cron` | `POST` (executa o tick); `GET` só diagnóstico | `CRON_SECRET` | 1 min (é o "ressuscitador" da cadeia de ticks) | tick de ~35 s por padrão (`tickBudgetMs`); lock `disparador_cron` com TTL 90 s renovado a cada 20 s | **Disparador para**: ninguém consome a fila, callbacks e retries atrasam. Campanhas já em fila ficam paradas até voltar. Inbox de mensagens/status (modos drenador) também só drena aqui. |
| `/api/disparador/prepare/cron` | `POST` | `CRON_SECRET` | 1 min | `maxDuration` 300 s; orçamento 240 s (`DISPARADOR_PREPARE_BUDGET_MS`); lock `disparador_prepare` | Campanhas **agendadas** não são preparadas no horário (ficam em `agendado`). Enquanto `DISPARADOR_PREPARE_IN_TICK` não for `false`, o tick de envio ainda faz o preparo como fallback. |
| `/api/disparador/health/cron` | `POST` | `CRON_SECRET` | 5–10 min | `maxDuration` 120 s; orçamento 90 s; lock `disparador_health` | Qualidade/tier dos números Meta só atualiza pelo webhook `phone_number_quality_update` (pode atrasar ou não chegar): limite/s automático desatualiza. |
| `/api/disparador/exports/cron` | `POST` | `CRON_SECRET` | 1 min | um job por vez com lease de 120 s; processa em blocos até o teto de 100 mil linhas; limpa arquivos vencidos (24 h) | Exportações grandes da fila do disparador ficam em "pendente" e o link nunca chega. As pequenas (até 10 mil linhas) continuam síncronas. |
| `/api/automations/cron` | `POST` (executa); `GET` só diagnóstico | `AUTOMATION_CRON_SECRET` | 1 min | até 50 execuções pendentes por chamada | Automações com espera (`automation_pending_executions`) não retomam. |
| `/api/flows/cron` | `POST` (executa); `GET` só diagnóstico | `AUTOMATION_CRON_SECRET` | 5 min (1 h seria tolerável para volume baixo) | até 200 runs varridos por chamada | **Não é opcional**: runs abandonados ficam `active` e bloqueiam novos gatilhos do contato; `smart_delay` não acorda; vigia de IA travada (conversa sem resposta há >180 s) não age. |
| `/api/channels/refresh-tokens` | `POST` | `AUTOMATION_CRON_SECRET` | 1 vez por dia | lote de 50 canais; renova tokens do Instagram que vencem em até 10 dias | Tokens longos do Instagram (60 dias) expiram e o canal vai para `error`. |
| `/api/conversations/retry-assignment` | `POST` | `AUTOMATION_CRON_SECRET` | 5 min | sem lote próprio documentado; olha conversas `pending` sem agente há ≥5 min | Conversas sem agente não são redistribuídas automaticamente. |
| `/api/disparador/imports/cron` | `POST` | `CRON_SECRET` | 1 min | `maxDuration` 120 s; orçamento 80 s; reserva por job (`FOR UPDATE SKIP LOCKED` + lease), sem lock global | Importações de contatos em segundo plano (migration 197) ficam paradas em `pending`/`running` — a campanha só fica com a lista completa depois que o job termina. Jobs abandonados (sem `start` em 24 h) também só são cancelados aqui. Contrato: `docs/disparador-importacao-assincrona.md`. |

Observações:

- `GET` em `/api/disparador/cron`, `/api/automations/cron` e `/api/flows/cron` **não executa nada**:
  só confere segredo e saúde da tabela. Agendadores devem usar `POST`.
- **Tick encadeado** (`DISPARADOR_TICK_CHAIN`): quando ligado, um tick que processou trabalho dispara
  o próximo (`x-cron-hop`) sem esperar o minuto; o cron externo continua obrigatório (hop 0).
  Variáveis: `DISPARADOR_CHAIN_URL` (senão `NEXT_PUBLIC_APP_URL`), `DISPARADOR_TICK_CHAIN_MAX_PER_MIN`,
  `DISPARADOR_TICK_CHAIN_MAX_HOPS`, `DISPARADOR_TICK_CHAIN_MAINTENANCE_EVERY`.
- Concorrência (dois agendadores ao mesmo tempo, várias instâncias) é resolvida no banco por locks com
  lease e claims atômicos; chamar a mais não duplica envio.
- **Não são crons** (não agendar): `/api/stress/run` (suíte de estresse, manual, `STRESS_RUN_SECRET`) e
  os webhooks (`/api/whatsapp/webhook`, `/api/meta/webhook`, `/api/whatsapp/webhook/waha`), que são
  chamados pela Meta/WAHA.

## Exemplo

Ver [`ops/crontab.example`](../ops/crontab.example). Substituir `<host>` e carregar os segredos de um
arquivo fora do repositório (não colar segredo em crontab versionado).

## Como conferir se está rodando

- `GET` com o segredo em cada rota de diagnóstico devolve `healthy`/`unavailable`.
- O tick do disparador grava uma linha `cron_tick` em `system_logs` por execução: ausência de linhas
  recentes = cron parado.
