# API pública (`/api/v1`)

A API pública permite integrar sistemas (ex.: planejamento de cobrança) ao CRM DDM sem usar o dashboard: enviar mensagens avulsas e criar/consultar campanhas do Disparador.

**Documentação completa e navegável:**

- Página no CRM (logado como owner, admin ou supervisor): **Configurações → API keys → "Ver documentação da API"** (`/settings/api-docs`).
- Especificação OpenAPI 3.1 (pública, sem chave): `GET /api/v1/openapi.json`. Fonte: `src/lib/api/v1/openapi.ts` — todo endpoint novo precisa ser documentado lá (um teste falha se faltar).

## Resumo

| Endpoint | Escopo | Para quê |
| --- | --- | --- |
| `GET /api/v1/me` | nenhum | Conta e escopos da chave |
| `POST /api/v1/whatsapp/send` | `messages:send` | Mensagem avulsa (texto/mídia); `Idempotency-Key` obrigatório |
| `GET /api/v1/contacts`, `GET /api/v1/contacts/{id}` | `contacts:read` (ou `contacts:write`) | Busca por telefone, CPF, e-mail, nome, etiqueta ou data; CPF só mascarado; 60/min por chave |
| `POST /api/v1/contacts` | `contacts:write` | Upsert por CPF/telefone: cria ou preenche só os vazios |
| `PATCH /api/v1/contacts/{id}` | `contacts:write` | Sobrescreve campos; `tags {add,remove}`; `custom_fields` em merge |
| `POST /api/v1/whatsapp/send-template` | `messages:send` | Um template aprovado da Meta a um número (só canal Meta; WAHA → 422); `Idempotency-Key` obrigatório; 60/min por chave |
| `GET /api/v1/templates` | `templates:read` (ou `messages:send` / `campaigns:write`) | Catálogo de templates: nome, idioma, nº de variáveis, `sendable_via_api` |
| `POST /api/v1/disparador/campaigns` | `campaigns:write` | Cria e enfileira campanha (até 20.000 contatos); idempotência opcional |
| `GET /api/v1/disparador/campaigns/{id}` | `campaigns:read` ou `campaigns:write` | Status e métricas |
| `GET /api/v1/reports/*` (`operations/current`, `operations/summary`, `teams`, `agents`, `tabulations`) | `reports:read` | Reporting API: métricas agregadas para BI (Power BI, Metabase, n8n). Detalhes em [`reporting-api.md`](./reporting-api.md) |

- **Autenticação:** `Authorization: Bearer wacrm_live_…`. Crie a chave em **Configurações → API keys** (owner/admin); o valor aparece uma única vez e só o hash é guardado. A chave age apenas na conta onde foi criada.
- **Envelope:** sucesso `{ "data": … }`; erro `{ "error": { "code": "…", "message": "…" } }` — ramifique pelo `code` (`unauthorized`, `forbidden`, `rate_limited`, `bad_request`, `not_found`, `conflict`, `payload_too_large`, `unprocessable`, `recipient_blocked`, `internal`…).
- **Limite:** 120 requisições por minuto por chave (`429` com `Retry-After`). O limitador é em memória, por processo.
- **Janela de envio:** horários em Brasília; campanhas respeitam janela e dias úteis.
- **Identificação de canal em campanhas:** `channel` aceita UUID, `waha_session` para WAHA ou número de telefone para Meta. Para integrações WAHA, prefira `waha_session` porque ele permanece estável mesmo se a linha for removida e recriada no CRM.

## Campanha WAHA com imagem — Fase 1

O mesmo `POST /api/v1/disparador/campaigns` aceita uma imagem por URL HTTPS **ou Base64** em canais WAHA. Não é necessário criar outra API key: o escopo continua sendo `campaigns:write`. O campo `message` é enviado como legenda da imagem e continua aceitando variáveis posicionais.

```json
{
  "campaign_name": "Getback - cobrança com imagem",
  "channel": "brdid_2139551698",
  "message": "Olá {{1}}, segue o material referente ao seu acordo.",
  "media": {
    "type": "image",
    "url": "https://cdn.exemplo.com/cobranca/acordo.jpg"
  },
  "contacts": [
    {
      "phone": "5521999998888",
      "variables": ["Maria"]
    }
  ]
}
```

Também é possível enviar Base64:

```json
{
  "campaign_name": "Getback - cobrança com imagem",
  "channel": "brdid_2139551698",
  "message": "Olá {{1}}, segue o material referente ao seu acordo.",
  "media": {
    "type": "image",
    "base64": "<BASE64_PURO>",
    "mime_type": "image/png"
  },
  "contacts": [
    {
      "phone": "5521999998888",
      "variables": ["Maria"]
    }
  ]
}
```

Regras da Fase 1:

- `media.type` deve ser `image`;
- informe **exatamente um** de `media.url` ou `media.base64`;
- `media.url` deve ser uma URL pública `https://`; localhost e redes privadas são bloqueados;
- `media.base64` deve ser Base64 puro, sem prefixo `data:`;
- com Base64, `media.mime_type` é obrigatório e aceita `image/jpeg`, `image/png` ou `image/webp`;
- imagens Base64 têm limite de **5 MB decodificados**;
- o Base64 é armazenado uma única vez no bucket privado `chat-media`; a fila guarda apenas a referência, mesmo para milhares de contatos;
- a mídia é suportada apenas para canal WAHA nesta fase;
- sem o campo `media`, o comportamento da API permanece exatamente o mesmo: campanha de texto WAHA ou template Meta.

A resposta de criação também informa `provider` e `message_type` (`text` ou `image`).

## MCP (DDM Intelligence)

Servidor MCP remoto (Streamable HTTP, sem estado, somente leitura) que
expõe as ferramentas de análise do DDM Intelligence — as mesmas do chat
do `/inteligencia` — para assistentes externos (Claude Desktop, Claude
Code, n8n).

- **URL:** `https://<seu-host>/api/mcp` (só `POST`).
- **Autenticação:** `Authorization: Bearer wacrm_live_…` de uma chave
  **pessoal** com o escopo `intelligence:read`.

### Chave pessoal

Crie em **Inteligência → Minhas chaves de API (MCP)**
(`/inteligencia/chaves`) — owner, admin e supervisor; cada um cria e
revoga só as próprias. Owner/admin também podem marcar
"Inteligência (leitura)" em **Configurações → API keys**.

A chave age como você: o escopo é recalculado a cada requisição
(owner/admin → conta toda; supervisor → só as equipes dele). Se o seu
papel mudar ou você sair da conta, o acesso muda/para na hora; chave
revogada para na hora. Ela não pode ser combinada com outros escopos.

Toda chamada de ferramenta é auditada (origem `mcp`) e conta no mesmo
limite por usuário do Intelligence (60/min). CPF, CNPJ e telefones
saem mascarados (ex.: `***.***.***-12`, `+55 11 9****-1234`).

### Conectar

Claude Code:

```bash
claude mcp add --transport http ddm https://<seu-host>/api/mcp \
  --header "Authorization: Bearer <sua-chave>"
```

Claude Desktop (`claude_desktop_config.json`, via `mcp-remote`):

```json
{
  "mcpServers": {
    "ddm": {
      "command": "npx",
      "args": [
        "mcp-remote", "https://<seu-host>/api/mcp",
        "--header", "Authorization:Bearer ${DDM_MCP_KEY}"
      ],
      "env": { "DDM_MCP_KEY": "<sua-chave>" }
    }
  }
}
```

Nunca coloque a chave em repositório ou em arquivo compartilhado.

## Webhooks de campanha e de destinatário (Onda 1, bloco B)

Pela fila de webhooks de saída já existente (`/api/v1/webhooks`: assinatura `X-CRM-Signature`, retry com backoff, replay, dedupe pelo `id`), só para quem **assinou** o tipo. Detalhe dos campos no OpenAPI (`/api/v1/openapi.json`, seção "Eventos de campanha e de destinatário").

| Evento | Quando | Origem |
| --- | --- | --- |
| `campaign.started` | campanha criada pela API e ativada, ou iniciada pelo painel | código, depois da ativação |
| `campaign.paused` | pausa **manual** (tela ou API). A automática continua `campaign.auto_paused` | código, depois da RPC de pausa (só se mudou) |
| `campaign.resumed` | retomada manual (tela ou API) | código, depois da RPC de retomada (só se mudou) |
| `campaign.completed` | fila esgotada (`complete_dispatch_campaign` devolveu verdadeiro) | código, no cron do disparador |
| `campaign.cancelled` | encerramento manual (tela `stop` ou API `cancel`) | código, depois da RPC de encerramento (só se mudou) |
| `recipient.status` | destinatário chegou a um status **final**: `delivered`, `read`, `error`, `blocked`, `removed` | trigger em `disp_message_queue` (migration 361) |
| `recipient.funnel` | clicou (`clicked`), fechou acordo (`closed`) ou pagou (`paid`, confirmado na DDM), com a atribuição `direct`/`ai`/`human` | trigger em `utmpay_links` (migration 362) |

- **Volume:** os dois eventos por destinatário podem passar de centenas de milhares por dia. Cada endpoint tem o teto `rate_limit_per_minute` (padrão 600, de 1 a 6000), configurável no `POST /webhooks` e no `PATCH /webhooks/{id}` (migration 360). O que passa do teto **espera** na fila (não se perde e não gasta tentativa); a janela é deslizante de 60 s. Ajuste ao que o ERP aguenta e assine só os tipos de que precisa. A retenção das entregas antigas continua fora desta entrega.
- **Cada status/etapa sai uma vez por destinatário** (`event_id` determinístico). `queued`/`sending`/`sent` não geram evento; o encerramento de campanha tem o seu próprio evento, com contagem, em vez de um evento por item cancelado.
- **Dado pessoal:** `recipient.*` leva o telefone do destinatário (nunca CPF nem o texto enviado). O erro sai só como `{ code, type }`, sem texto técnico.
- **Quem emite o quê:** ciclo de vida em `src/lib/webhooks-out/campaign-events.ts` (`emitCampaignStarted|Paused|Resumed|Completed|Cancelled`, melhor esforço, nunca lançam); a API de controle de campanha (pause/resume/cancel) chama `emitCampaignPaused|Resumed|Cancelled` com `by: 'api'`, só quando o estado mudou.
- **Migrations:** 360 (limite por endpoint), 361 (`recipient.status`), 362 (`recipient.funnel`); aplicar na ordem 360 → 361 → 362, depois da 204 (e da 356 para a 362). Sem elas o app segue funcionando; só faltam os eventos por destinatário e o limite configurável.
