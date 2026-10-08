# PRD 11 — Disparador e filas (V2 backend)

**Versão:** V2 · **Base:** branch `v2` · **Data:** 08/10/2026
**Fontes:** auditoria DISP-AUDIT de 07/10 (achados F1–F27, W1–W8, A1–A25, com arquivo:linha nos anexos B1/B2), PRD 08 (capacidade), PRs #103–#146 já em produção.
**Fora deste PRD:** worker dedicado (PRD 12), segurança transversal (PRD 14), plataforma/CI/deploy (PRD 15), retenção de dados (fora por decisão do dono), telas (frontend de outra pessoa — aqui só os contratos).

## 1. Resumo
O motor do disparador já passou por P0/P1 da auditoria (correções de perda de mensagem, lock de 90 s, pausa instantânea, recibos em lote duráveis, catálogo de erros, tetos 150, limite/s por qualidade, Monitor/Erros/Números/Controles). Falta: **(a)** validar e ligar em produção o que entrou desligado (claim em lote, tick encadeado), **(b)** fechar as dívidas de média/baixa severidade que ainda custam desempenho ou podem perder dado sob carga, **(c)** completar as operações seguras de fila (reenvio/cancelamento em lote, incertos) e **(d)** alertas. Ganho: 1 número sustentando 80 envios/s (F1) sem perder recibo, com operação 100% pelo CRM.

## 2. Estado atual (produção em 08/10)
| Peça | Situação | Onde |
|---|---|---|
| Ciclo de envio | cron externo 1×/min, lock `disparador_cron` TTL 90 s renovado a cada 20 s | #133, `cron/route.ts` |
| Tick encadeado | pronto, **desligado** (`DISPARADOR_TICK_CHAIN=1`) — exige proxy EasyPanel ≥ 60 s | #136, `tick-chain.ts` |
| Claim | unitário O(1) (167) com pausa por número (192); **claim/confirmação em lote prontos e desligados** (`DISPARADOR_BATCH_CLAIM=1`) | #137, migration 188 |
| Tetos | 150 por número (Meta) / 50 (WAHA); global 150; padrão do `.env` | #136, migration 186 |
| Limite/s por número | token bucket no tick, padrão pela qualidade (80/40/8/5), rampa, manual com auditoria | #140, migration 190 |
| Recibos de status | `webhook_status_inbox` durável + `apply_dispatch_statuses` em lote | #134, migration 185 |
| Métricas | deltas só-insert + consolidação no cron + view `campaign_metrics_live` | #128, migration 183 |
| Erros | catálogo único + `erro_codigo` | #135, migration 187 |
| Operação | Monitor v2, Desempenho 24 h, Erros (só leitura), Números/Controles (vagas, limite/hora, limite/s, pausar número) | #138, #139, #141, #145, #146 |
| Medição | ~480/min por número medido com 12 vagas; teórico F1 ≈ 4.800/min em 1 número (não medido — bancada pronta, #132, não rodada) | DISP-AUDIT §1 |

## 3. Problemas e riscos em aberto
Severidade revista após os PRs de 07–08/10. Os IDs remetem aos anexos da DISP-AUDIT (arquivo:linha lá). **Reverificar cada um na `v2` antes de implementar** — vários arquivos mudaram.
| ID | Sev. | Problema | Cenário | Correção |
|---|---|---|---|---|
| F14 | **ALTA** | Watchdog marca `enviando` > 2 min como erro permanente sem heartbeat do envio | tick encadeado/worker com envio lento legítimo vira "incerto" | heartbeat por item em voo (ou `claimed_at` + dono) e watchdog só sobre itens sem dono vivo |
| F13 | ALTA | 200 da Meta sem `messages[0].id` (corpo truncado) vira `TypeError` fora de `MetaApiError` | timeout no meio da resposta: item fica sem classificação correta | validar o corpo e tratar como **incerto** (não reenviar) |
| A3 | ALTA | campanha agendada com falha 5xx persistente é retentada **todo minuto** (DELETE fila + leitura de público), sem backoff | carga inútil no banco no pior momento | backoff exponencial + `motivo_falha_inicio` + alerta após N falhas |
| A12/A13 | ALTA | import: parse síncrono de CSV/XLSX no event loop; trigger de auditoria por contato (100k linhas em `audit_logs`) | import de 100k trava o processo e infla `audit_logs` | parse em streaming/fatias com yield; auditoria agregada por lote de import |
| A4/A5 | MÉDIA | público e blacklist carregados inteiros (contatos da conta / blacklist de todas as contas) | prévia/modal de público lenta com base grande | consultas por chave/keyset (já existe `blacklisted_phone_keys`) |
| A20/A21/A22 | MÉDIA | OFFSET e `count: exact` em fila de 100k (callback, queue-details, desempenho/live) | painéis e exportação lentos/derrubam o pooler | keyset + contagens via `dispatch_monitor_counts`/métricas live; exportação assíncrona |
| F7 | MÉDIA | consulta do auto-pause O(tamanho da campanha) | campanha grande deixa o auto-pause lento | índice parcial dedicado + EXPLAIN no live |
| F12 | MÉDIA | `writeLog` por item de erro sem limite (rajada de INSERT em `system_logs`) | token expirado → milhares de logs por minuto | log agregado por (campanha, código) por janela |
| F16 | MÉDIA | `FOR SHARE` na campanha a cada claim unitário (multixact) | 40+ claims concorrentes | resolvido ao ligar o claim em lote (#137) — validar e desligar o unitário |
| F17 | MÉDIA | 1 falha de renovação do lease para o tick inteiro | Supabase lento sob carga | tolerar N falhas seguidas dentro do TTL |
| W5/W6/W8 | BAIXA | status antes do INSERT do Inbox perdido para o Inbox; reconcile LIMIT 100/min; recibo órfão 7 dias | backlog de recibos | reaplicação periódica, lote maior, TTL 24–48 h |
| A7 | MÉDIA | API v1: campanha `rascunho` + chave de idempotência antes da fila; crash antes do rollback deixa chave presa | integrador recebe 409 "em andamento" para sempre | expirar reserva sem resposta após N min e liberar |
| A8/A9/A10/A11 | MÉDIA/BAIXA | API v1: variáveis não validadas contra o template; 20k em 40 INSERTs sequenciais; teto de corpo em caracteres; `maybeSingle` com sessão duplicada | 132000 em massa; lentidão; 413 errado | validar `{{n}}`; `insertInBlocks` concorrente; medir bytes; `.limit(1)` |
| A14–A19, A23–A25, F21–F27 | BAIXA | ordem do RETURNING no import, reenvio do bloco 0, "já enviado" por contato, round-robin com bloqueados, preparo concorrente, `x-internal-cron` sem tempo constante, OFFSET no reflow, métricas/previsão imprecisas, média de resposta não atômica | ver anexos | PRs de limpeza agrupados |
| A6 | decisão | blacklist global entre contas | — | **pergunta ao dono** (§13) |

## 4. Objetivos e não-objetivos
**Objetivos:** (1) ligar com segurança claim em lote e tick encadeado; (2) 1 número sustentando ≥ 4.500 envios/min na bancada (S3) e em produção em degraus; (3) zero recibo perdido e zero envio duplicado sob reinício (S9/S10); (4) operações de fila em lote seguras (reenviar/cancelar, incertos); (5) alertas automáticos; (6) fechar ALTA/MÉDIA da tabela.
**Não-objetivos:** retenção; mudar `limite_por_hora`; vários números a 80/s no mesmo processo (PRD 12); telas.

## 5. Requisitos
| # | Requisito | Aceite |
|---|---|---|
| R1 | Bancada (#132) rodada em staging nos cenários S0–S3, S7, S9–S11 com relatório | tabela de resultados anexada ao PRD; S3 ≥ 4.500/min, lag p99 < 100 ms, 0 duplicado, 0 recibo perdido |
| R2 | Ligar `DISPARADOR_BATCH_CLAIM=1` e `DISPARADOR_TICK_CHAIN=1` em produção em degraus | 1 dia por degrau sem regressão no Desempenho; rollback = desligar a env |
| R3 | Heartbeat de itens em voo (F14) | nenhum envio legítimo > 2 min marcado incerto na bancada com latência de 3 s |
| R4 | Corpo da Meta validado (F13) | teste com resposta truncada → incerto, sem reenvio |
| R5 | Backoff de preparação (A3) | falha 5xx persistente: 1, 2, 4, 8… min, máx. 30; alerta após 5 |
| R6 | Import 100k sem travar (A12/A13) | lag p99 < 100 ms durante import de 100k; `audit_logs` com 1 linha por lote |
| R7 | Leituras de painel sem OFFSET/`count exact` na fila (A20–A22) | `pg_stat_statements` sem varredura da fila nos endpoints de painel |
| R8 | Reenviar/cancelar em lote (P2-1) | dry-run obrigatório, teto, confirmação digitada, exclusões (`enviando`, com `waha_message_id`, 131026 pendente, blacklist/opt-out), auditoria; teste SQL de não-duplicidade |
| R9 | Reprocesso de incertos (P2-7) | só humano, com revisão item a item ou por amostra; nunca automático |
| R10 | Alertas (com PRD 15) | pausa automática, freio recorrente, qualidade caiu, sem `cron_tick` há 3 min, backlog de recibos > 5 min |

## 6. Desenho proposto
- **Ligar o que está pronto** (sem código novo): roteiro de staging → produção, envs por degrau, critérios de parada.
- **Heartbeat (F14):** coluna `disp_message_queue.inflight_until` (ou tabela de leases por item em voo) renovada pelo processo que enviou; watchdog só finaliza itens com lease vencido. Compatível com o worker do PRD 12 (mesmo mecanismo).
- **Operações em lote (R8):** RPCs `requeue_queue_items(p_filter jsonb, p_dry_run, p_limit)` e `cancel_queue_items(...)` com as exclusões no SQL (não na UI); `p_dry_run=true` devolve contagem e amostra; a execução exige um `confirm_token` devolvido pelo dry-run (vale 5 min) — impede "clicar duas vezes".
- **Painéis sem varredura:** contagens só de `dispatch_monitor_counts` (189) e `campaign_metrics_live`; exportação de fila vira job (tabela `dispatch_export_jobs` + cron) com arquivo no Storage.
- **Import:** parse em fatias com `setImmediate` entre fatias (ou no worker do PRD 12 quando existir); auditoria por lote via `audit_logs` com `import_id`.

## 7. Dados e migrations (numeração a coordenar — próximo livre ≥ 194)
| Migration | Conteúdo | Ordem |
|---|---|---|
| 194 | `inflight_until` + índice parcial; watchdog usa o lease | antes do deploy |
| 195 | RPCs de reenvio/cancelamento em lote com `confirm_token` | antes |
| 196 | backoff de preparação (`prepare_attempts`, `next_prepare_at`) | antes |
| 197 | auditoria agregada de import + índice do auto-pause (F7, `CONCURRENTLY` em arquivo próprio) | antes |
| 198 | `dispatch_export_jobs` | antes |
Todas idempotentes, com pré-check (`pg_get_functiondef` do que alteram).

## 8. Contrato para o frontend
| Rota | Método | Papel | Uso |
|---|---|---|---|
| `/api/disparador/monitor/snapshot` | GET | supervisor+ | já existe (#138) — números, campanhas, erros 15 min, feed |
| `/api/disparador/limits` | GET/PUT | admin+ (PUT) | já existe (#141) |
| `/api/disparador/rate-limits` (+ `/[session]/revert-auto`, `/acknowledge`) | GET/PUT/POST | admin+; owner p/ política | já existe (#140) |
| `/api/disparador/health/refresh` | POST | admin+ | já existe (#145), 1/min |
| `/api/disparador/erros`, `/erros/[id]` | GET | admin+ | já existe (#139) |
| **novo** `/api/disparador/fila/acoes` | POST `{acao:'reenviar'|'cancelar', filtro, dry_run:true}` → `{total, amostra[], excluidos{motivo:n}, confirm_token}`; POST `{…, confirm_token}` → `{afetados}` | admin+ | R8 |
| **novo** `/api/disparador/exportacoes` | POST cria job; GET lista/status/link | admin+ | R7 |
Erros no padrão `{ error, code }` com códigos estáveis (catálogo do PRD 15).

## 9. Testes e aceite
Unit + PGlite para todas as RPCs novas (inclui "dois cliques" no reenvio = 1 execução), bancada S0–S11 em staging (relatório versionado em `docs/`), testes de não-duplicidade (S10: `count(*)` por `waha_message_id` e por `(campaign_id, contact_id, template)` = 0 duplicados) e de reinício (S9).

## 10. Observabilidade
`cron_tick` (já), eventos novos: `queue_bulk_action` (quem/filtro/afetados), `prepare_backoff`, `inflight_lease_expired`; alertas do R10 via PRD 15.

## 11. Riscos, rollback e implantação
Tudo atrás de flag/env; ordem: bancada → claim em lote → tick encadeado → heartbeat → operações em lote. Rollback = desligar a env (claim e encadeamento) ou reverter a RPC (migrations com bloco de rollback documentado). Degraus de vagas 24→48→100 com 1 dia cada.

## 12. Fases e PRs (base `v2`)
1. **Ops (sem código):** staging + bancada S0–S3/S7/S9–S11; relatório. (OPS+BE, M)
2. **PR heartbeat + corpo da Meta** (F14, F13) — migration 194. (BE, M)
3. **PR backoff de preparação + alerta** (A3) — 196. (BE, P)
4. **PR painéis sem varredura + exportação assíncrona** (A20–A22) — 198. (BE, M)
5. **PR import sem travar** (A12/A13) — 197. (BE, M)
6. **PR operações em lote seguras** (R8) — 195; revisão com o modelo mais forte. (BE, G)
7. **PR reprocesso de incertos** (R9). (BE, M)
8. **PR limpeza** (F7, F12, F17, W5/W6/W8, A7–A11, A14–A19, A23–A25, F21–F27). (BE, M)
9. **Ligar em produção:** claim em lote → tick encadeado, em degraus.

## 13. Perguntas ao dono
> Regra do dono (08/10): nada aqui muda regra de negócio (mensagens, templates, régua, critérios de cobrança). As perguntas abaixo são técnicas/operacionais.
1. **Blacklist global entre contas (A6):** hoje um opt-out numa conta bloqueia o número em todas. Manter (mais seguro para LGPD/opt-out) ou separar por conta?
2. **Reenvio em lote:** quem pode — só owner ou admin também? Teto por operação (sugestão: 20.000)?
3. **Incertos (resultado desconhecido):** permitir reprocesso humano com risco de duplicar, ou nunca reenviar e só reportar?
4. **Alertas:** canal preferido (e-mail, WhatsApp de um número interno, Slack)?
