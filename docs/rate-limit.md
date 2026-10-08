# Rate limit compartilhado (PRD 14, 14.9 — migration 221)

Antes, os limites (`src/lib/rate-limit.ts`) viviam num `Map` **por processo**: cada instância do Passenger e cada restart/deploy
zeravam o contador (N instâncias = N× o limite). Agora há dois níveis, **sem infraestrutura nova** (Postgres, não Redis):

1. **Map do processo** — barra rajada dentro da instância sem custo de rede.
2. **Contador no Postgres** — RPC `wacrm.rate_limit_hit(chave, limite, janela_s)`: um upsert atômico numa janela fixa alinhada ao
   relógio do banco (tabela `wacrm.rate_limit_buckets`, `UNLOGGED`, fechada ao `service_role`; limpeza probabilística +
   `wacrm.rate_limit_cleanup()` sob demanda).

`checkRateLimit(chave, {limit, windowMs})` é **assíncrono** (`await`). Se a RPC falhar, demorar mais de 1 s ou não existir
(migration 221 ainda não aplicada), vale só o Map por 30–60 s e a rota segue — **o limitador nunca derruba a rota**.
Sem `SUPABASE_SERVICE_ROLE_KEY` (testes/dev) só o Map. Quando o banco nega, o Map da instância é saturado até o fim da janela
(não repete a RPC em enxurrada).

## Onde vale

| Rota / uso | Chave | Limite |
|---|---|---|
| envio, reação, convites (peek/redeem/redeem-by-code), ações de admin, simulador, IA, Intelligence, `channel-test`, verificação do webhook Meta (GET) | como antes | **os mesmos valores de antes** |
| API pública `/api/v1/*` e MCP — por chave | `apikey:<id>` | 120/min |
| **AP-09** tentativas com chave inválida (por IP) | `apikey-fail:<ip>` | 30/min — barra **antes** de consultar o banco |
| **AP-08** `/api/telemetry` e `/api/feedback` | `telemetry:<user>` / `feedback:<user>` | 60/min (+ texto e payload truncados) |
| **AP-19** webchat público (por IP + token): GET/poll/mídia · abrir/upload | `webchat:read|write:<ip>:<token>` | 120/min · 30/min |

## Onde NÃO usar

Cada chamada limitada custa **1 RPC** (~5–15 ms). Por isso nenhuma rota quente do disparador (cron, tick, webhook de status/WAHA, motor
de envio) chama o limitador — um teste (`src/lib/rate-limit.routes.test.ts`) garante. Para caminho quente use `checkRateLimitLocal`
(síncrono, só o Map).

## Operação

- Conferir: `SELECT * FROM wacrm.rate_limit_hit('teste', 2, 60);` (3ª chamada → `success = false`) e apagar a linha de teste.
- Limpeza manual: `SELECT wacrm.rate_limit_cleanup();`
- Sem a 221 nada quebra: o app usa o Map, como antes.
