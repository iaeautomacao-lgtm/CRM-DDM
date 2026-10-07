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

- **Autenticação:** `Authorization: Bearer wacrm_live_…`. Crie a chave em **Configurações → API keys** (owner/admin); o valor aparece uma única vez e só o hash é guardado. A chave age apenas na conta onde foi criada.
- **Envelope:** sucesso `{ "data": … }`; erro `{ "error": { "code": "…", "message": "…" } }` — ramifique pelo `code` (`unauthorized`, `forbidden`, `rate_limited`, `bad_request`, `not_found`, `conflict`, `payload_too_large`, `recipient_blocked`, `internal`…).
- **Limite:** 120 requisições por minuto por chave (`429` com `Retry-After`). O limitador é em memória, por processo.
- **Janela de envio:** horários em Brasília; campanhas respeitam janela e dias úteis.

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
