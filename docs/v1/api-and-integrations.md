# APIs e integrações

## Superfície HTTP

O baseline possui 111 Route Handlers.

Categorias:

- API da UI;
- webhooks;
- crons;
- API pública;
- MCP;
- proxies;
- health/stress.

## API pública `/api/v1`

Endpoints presentes:

- `GET /api/v1/me`
- `POST /api/v1/whatsapp/send`
- `GET/POST /api/v1/disparador/campaigns`
- `GET /api/v1/disparador/campaigns/[id]`

Escopos conhecidos:

- messages:send/read
- contacts:read/write
- conversations:read
- campaigns:write/read
- intelligence:read

## MCP

`POST /api/mcp`: DDM Intelligence via Streamable HTTP stateless, read-only e chave pessoal.

Resources MCP da V2 (#63) não fazem parte deste baseline.

## Webhooks

- Meta WhatsApp: `/api/whatsapp/webhook`
- WAHA: `/api/whatsapp/webhook/waha`
- Social: `/api/meta/webhook`

## Crons

- automations
- disparador
- flows
- retry de assignment

## Integrações

- Supabase
- Meta
- WAHA
- OpenAI
- Gemini
- Claude
- OpenRouter/Hermes
- DDM Acordos
- UTMPay
- VoIP

Credenciais reais nunca devem ser documentadas.
