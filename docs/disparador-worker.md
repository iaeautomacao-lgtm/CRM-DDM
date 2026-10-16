# Worker de envio do Disparador (W0–W3)

Processo Node separado que envia campanhas **em lote** de números Meta, no mesmo estágio de envio do cron (`src/lib/disparador/send-stage.ts`). Existe para o alvo de 20 números × 80 msg/s ao mesmo tempo (PRD 12 / `prd-v2/disparador-4800-pronto.md`).

**Nada muda enquanto a chave estiver desligada**: o cron de hoje continua enviando tudo.

## Como as peças se encaixam

| Etapa | O quê |
|---|---|
| W0 | Extração do estágio de envio do cron para `send-stage.ts` (sem mudar comportamento) |
| W1 | Migration 367: dono do número (`dispatch_channel_ownership`, modo `cron`/`worker`), lease com TTL (`dispatch_worker_leases`), chave `worker_enabled` por conta |
| W2 | Migration 368: balde durável por número (GCRA) e `claim_dispatch_batch_rated` (fencing do lease + taxa) |
| W3 | O processo (`src/worker/`), bundle único, modelos de infra |

## Regras de convivência com o cron

- Chave `worker_enabled` (por conta, `PUT /api/disparador/engine`; padrão **desligada**). Desligada: worker ocioso e sem leases; cron envia tudo.
- Com a chave ligada **e** um worker vivo com lease no número, o cron pula esse número **apenas para campanha em lote**. Campanha **sequencial** (`batch_size` ≤ 1, cadência por `reserve_campaign_tick`) fica sempre com o cron.
- Lease: TTL 30 s, renovado a cada 10 s. Worker caiu: o lease vence em ≤ 30 s e o cron volta a cobrir. Itens em voo ficam `enviando` e o watchdog os fecha como incertos (**nunca reenvia**).
- Perdeu o lease no meio: o claim devolve `not_owner`, o número sai do conjunto do processo na hora.
- Justiça entre números: cada número tem balde e lease próprios; não há fila global.

## Execução

```bash
npm run build:worker                       # dist/dispatch-worker.cjs (~2,3 MB, dependências embutidas)
node dist/dispatch-worker.cjs --check      # fumaça: carrega e sai 0, sem env nem banco
node dist/dispatch-worker.cjs              # sobe (exige NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY)
```

Variáveis opcionais: `DISPATCH_WORKER_ID`, `DISPATCH_WORKER_GROUP`, `DISPATCH_WORKER_MAX_NUMBERS` (padrão 2), `DISPATCH_WORKER_DRAIN_MS` (padrão 8000). Códigos de saída: 0 parada limpa, 1 erro, 2 env ausente, 3 migration 367/368 ausente.

Parada (SIGTERM/SIGINT): para de iniciar envios, espera os em voo (≤ 8 s), drena as confirmações em micro-lote e expira os leases; limite duro de 15 s.

## Rodadas e caudas

Cada número tem o seu estágio de envio: a rodada só espera o orçamento de início (DISPATCH_WORKER_ROUND_MS, 20 s); o que ficou em voo termina em segundo plano e não atrasa os outros números nem o planejamento seguinte. Detalhes e medidas: docs/disparador-bancada-carga.md, seção 7.

## Observabilidade

- `system_logs`: evento `dispatch_worker_tick` (a cada ≥ 15 s com trabalho; traz `worker.sent_per_s`, números próprios e o payload de telemetria do tick).
- Linhas de log estruturadas no stdout: `dispatch_worker_boot`, `…_lease_acquired`, `…_lease_lost`, `…_stopping`, `…_shutdown`.
- Batimento global `dispatch_worker` (30 s) no cartão de saúde dos crons: "indisponível" quando nunca bateu (não é alarme).
- Estatísticas por lease (envios/s, voo, atraso do event loop, RSS) em `dispatch_worker_leases.stats`.

## Infra (modelos, **não aplicados**)

- `ops/systemd/dispatch-worker@.service` + `dispatch-worker.env.example`: uma unidade por instância, `Restart=always`, `TimeoutStopSec=20`.
- `scripts/deploy-worker.sh`: rolante por instância, symlink `current`, rollback para a release anterior.
- Recomendação já aceita: **máquina própria** (KVM 4 da Hostinger primeiro; KVM 8/2ª KVM para os 20 números), **não** o `server.ddmsrv.com` (carga alta compartilhada).

## Segredos

Opção A do PRD 12 (só no piloto): o worker tem `ENCRYPTION_KEY` e decifra o token do canal. Antes de escalar, corretor de credenciais (opção B) para o worker não precisar da chave. Chave de IA continua da conta; campanha com IA fica no cron.
