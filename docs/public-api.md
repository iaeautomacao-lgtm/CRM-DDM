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
| `POST /api/v1/disparador/campaigns` | `campaigns:write` | Cria e enfileira campanha (até 20.000 contatos); idempotência opcional |
| `GET /api/v1/disparador/campaigns/{id}` | `campaigns:read` ou `campaigns:write` | Status e métricas |
| `GET /api/v1/reports/*` (`operations/current`, `operations/summary`, `teams`, `agents`, `tabulations`) | `reports:read` | Reporting API: métricas agregadas para BI (Power BI, Metabase, n8n). Detalhes em [`reporting-api.md`](./reporting-api.md) |
| `GET /api/v1/conversations` e `/{id}` | `conversations:read` | Listagem paginada, metadados e operador |
| `GET /api/v1/conversations/{id}/messages` | `conversations:read` | Transcrição INTEGRAL, paginada, desde a primeira mensagem |
| `GET /api/v1/conversations/{id}/events` | `conversations:read` | Execuções de IA, transferências e alterações de status |
| `POST /api/v1/conversations/messages/batch` | `conversations:read` | Transcrições de até 10 conversas por chamada, com cursores independentes |
| `POST /api/v1/conversations/exports` | `conversations:export` | Exportação assíncrona privada em NDJSON |
| `GET /api/v1/conversations/exports/{id}` | `conversations:export` | Status, link temporário do arquivo e cursor de continuação |

- **Autenticação:** `Authorization: Bearer wacrm_live_…`. Crie a chave em **Configurações → API keys** (owner/admin); o valor aparece uma única vez e só o hash é guardado. A chave age apenas na conta onde foi criada.
- **Envelope:** sucesso `{ "data": … }`; erro `{ "error": { "code": "…", "message": "…" } }` — ramifique pelo `code` (`unauthorized`, `forbidden`, `rate_limited`, `bad_request`, `not_found`, `conflict`, `payload_too_large`, `recipient_blocked`, `internal`…).
- **Limite:** 120 requisições por minuto por chave (`429` com `Retry-After`). O limitador é em memória, por processo.
- **Janela de envio:** horários em Brasília; campanhas respeitam janela e dias úteis.
- **Identificação de canal em campanhas:** `channel` aceita UUID, `waha_session` para WAHA ou número de telefone para Meta. Para integrações WAHA, prefira `waha_session` porque ele permanece estável mesmo se a linha for removida e recriada no CRM.

## Consulta de conversas completas

Consulte [docs/conversations-api.md](./conversations-api.md) para exemplos de páginas de mensagens, lote, eventos, permissões, exportação assíncrona, cron e migration 194. **O escopo reports:read continua apenas agregado e não dá acesso a históricos.** `conversations:read` devolve dados pessoais de clientes e requer chave protegida no backend; `conversations:export` é permissão separada para exportações.

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
