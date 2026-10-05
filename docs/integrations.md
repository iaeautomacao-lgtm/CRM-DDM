# Integrações

## WhatsApp: Meta Cloud API

O caminho Meta usa a API oficial da Meta para envio, templates, status e webhooks.

Código principal:

- `src/lib/whatsapp/meta-api.ts`
- `src/app/api/whatsapp/webhook/route.ts`
- rotas em `src/app/api/whatsapp/templates/`

Cuidados:

- validar assinatura do webhook;
- respeitar templates aprovados quando a janela de conversa exigir;
- tratar status assíncronos;
- nunca assumir que HTTP 2xx significa entrega ao destinatário.

## WhatsApp: WAHA

WAHA é um caminho separado do Meta e possui contratos diferentes.

Código principal:

- `src/lib/whatsapp/waha-api.ts`
- `src/app/api/whatsapp/webhook/waha/route.ts`
- helpers em `src/lib/flows/waha-send.ts`

Não tente unificar semântica de template, sessão e envio com Meta apenas para reduzir código. A bifurcação é parte do domínio.

## Webchat

O Webchat cria sessões e conversa no mesmo modelo de dados do CRM.

Código:

- `src/lib/webchat/`
- `src/app/api/webchat/`
- `src/app/w/`

Ele permite reaproveitar flow engine, IA, histórico e handoff sem depender de WhatsApp.

## Instagram e Messenger

A fundação omnichannel usa `channels` e rotas em `src/app/api/channels` e `src/app/api/meta`.

As credenciais são server-side e o vínculo de canal precisa manter `account_id`, equipe e flow coerentes.

## LLM providers

A camada de IA suporta configuração de provider e chaves por ambiente/conta.

Principais providers contemplados pelo código:

- OpenAI;
- Gemini;
- Claude/Anthropic;
- OpenRouter/Hermes.

Código:

- `src/lib/ai/responder.ts`
- `src/lib/ai/llm-shared.ts`

A resposta da LLM não é autoridade sobre dados financeiros. Valores e condições devem vir das integrações autorizadas.

## DDM Acordos

A integração DDM é usada pelo agente para consulta e formalização de cobrança.

Credencial preferida:

```env
DDM_ACORDOS_API_TOKEN=
```

Regras:

- token nunca deve estar hardcoded em flow node, código ou documentação;
- CPF e dados retornados são PII;
- erro textual, corpo inválido ou erro de negócio devem ser classificados como falha mesmo com HTTP 2xx;
- retries devem ser limitados a operações seguras/idempotentes;
- após falha definitiva, o fluxo precisa terminar ou fazer handoff, nunca ficar órfão.

## UTMPay

Usado pelo disparador para geração e métricas de links rastreados.

```env
UTM_API_KEY=
```

A chamada é feita server-side; o browser não recebe a chave.

## Supabase

Supabase fornece:

- PostgreSQL;
- Auth;
- Storage;
- Realtime;
- PostgREST/RPC.

O CRM usa explicitamente o schema `wacrm`.

## VoIP

O serviço auxiliar em `voip/` é executado separadamente e autenticado por segredo de serviço.

```env
VOIP_URL=
VOIP_SERVICE_SECRET=
```

Veja [../voip/README.md](../voip/README.md).

## API pública do CRM

Integrações externas podem usar `/api/v1` com API keys account-scoped e scopes.

Veja [public-api.md](./public-api.md).
