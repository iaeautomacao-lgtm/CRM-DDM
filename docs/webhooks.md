# Webhooks endurecidos (PRD 14, 14.10 — SW-3, SW-4, SW-5, SW-6)

URL, handshake e formato de chamada **não mudam** (Meta e WAHA seguem separados). O que mudou, por webhook:

| Webhook | Teto de corpo (SW-5) | Autenticação antes do parse | Idempotência (SW-6) |
|---|---|---|---|
| `POST /api/whatsapp/webhook` (Meta WhatsApp) | 1 MB — `Content-Length` **e** leitura do stream (chunked sem tamanho não escapa) | `X-Hub-Signature-256` precisa ser `sha256=<64 hex>` antes de qualquer `JSON.parse` (401); o HMAC **por canal** é conferido logo depois de achar o canal no corpo (o segredo é do canal, então o canal precisa sair do corpo) | por `wamid`, agora **por conta** |
| `POST /api/meta/webhook` (Instagram/Messenger) | 1 MB, idem | HMAC sobre o **bruto** contra os segredos configurados **antes** do `JSON.parse`; depois do parse exige o segredo certo para o objeto (`instagram` × `page`) | por `mid`, agora **por conta do canal** |
| `POST /api/whatsapp/webhook/waha` | 1 MB, idem (depois da autenticação) | segredo por canal (`x-webhook-secret` + `?channel=`) **antes de ler qualquer byte** | atômica, por conta (abaixo) |
| `GET /api/whatsapp/webhook` (verificação da Meta) | — | `verify_token` em tempo constante; **30/min por IP no limitador compartilhado** (migration 221, `docs/rate-limit.md`) | — |

## SW-4 — segredo global legado do WAHA

`WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET` é **desligada por padrão** (só `=true` liga). Ligada, o segredo global é aceito sem `?channel=` e a
sessão é resolvida só por `waha_session` — o que reabre o C-3 para quem viu o segredo. Cada evento que entra por esse ramo agora grava
um aviso `waha_legacy_secret_used` em `system_logs` (conta, canal e sessão; no máximo 1× por sessão a cada 10 min), para o operador
saber **quais canais ainda precisam reiniciar a sessão** pelo CRM. Quando não houver mais avisos, desligar a flag (e depois apagar o ramo).

## SW-6 — idempotência do WAHA

- A checagem "já gravei esta mensagem?" é **escopada pela conta do canal autenticado** (também no webhook Meta e no social).
- O INSERT é o desempate **atômico**: violação de unicidade (`23505`, índice `idx_messages_message_id_unique`, migration 088) vale
  como "já sincronizada" (200), não como erro 500 — o WAHA não reenvia em laço.
- **Não houve migration:** o índice único atual já dá a atomicidade. Ele é **global** (`message_id` sozinho); por isso, dois tenants com o
  mesmo `message_id` ainda colidiriam no INSERT. Para tirar essa última colisão é preciso (1) criar o índice composto
  `(account_id, message_id)` com `CREATE INDEX CONCURRENTLY` em arquivo próprio (`222b`), (2) escopar por conta as outras ~12 leituras por
  `message_id` (engine de fluxos, reply-tracker, persist-outbound, reações…) que hoje assumem unicidade global e (3) só então
  `DROP INDEX CONCURRENTLY idx_messages_message_id_unique`. Não foi feito aqui: o risco (leituras `maybeSingle()` falhariam com duas linhas)
  supera o ganho, já que o id do WAHA/Meta é aleatório e global na prática. Decisão pendente do dono/orquestração.

## Não coberto (de propósito)

- Janela de aceitação de `timestamp` do WAHA (PRD: rejeitar `message.any` com mais de 24 h): barraria sincronização de histórico legítima; fica como decisão.
- Campo `flags_inseguras` em `/api/health`: não existe `/api/health` no projeto ainda (PRD 15).
