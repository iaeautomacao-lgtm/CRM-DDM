# V2 do CRM-DDM: PRDs de backend (índice)

**Data:** 08/10/2026 · **Base:** branch `v2` (= `main` + PRs da V2 já mergeados)

**Escopo:** só lógica e código: robustez, desempenho, segurança, observabilidade, bugs técnicos e contratos de API.
- **Fora do escopo:**
  - frontend, que fica com outra pessoa (cada PRD traz o **contrato de API** que ela vai consumir);
  - **regras de negócio** (prompt, textos e personas da IA, encerramento, tratamento de ofensa, acordo, mensagens e régua de cobrança). Aparecem só como "Decisão da operação";
  - **retenção de dados**.
- **Decisões do dono que valem para todos os PRDs:**
  - o worker dedicado de envio (F2) **entra** na V2;
  - Meta e WAHA nunca são unificados;
  - migrations são manuais e idempotentes, com pré-check;
  - nada de worker em memória dentro do Passenger;
  - não mexer na truncagem do engine nem em `hasRunLeftNodeSnapshot`;
  - opt-out é obrigatório;
  - `limite_por_hora` não muda.

## Documentos

| # | PRD | Autor | Conteúdo |
|---|---|---|---|
| 11 | [Disparador e filas](11-disparador-e-filas.md) | Orquestrador | Ligar o claim em lote e o tick encadeado com segurança, heartbeat de itens em voo, painéis sem varrer a fila, import sem travar, operações de fila em lote seguras, dívidas F/A/W da auditoria |
| 12 | [Worker dedicado de envio (F2)](12-worker-envio-f2.md) | Âncora | Extrair o motor da rota do cron, lease por número, limite/s no banco, pooler, SIGTERM, ingestão de webhook separada, roteiro no EasyPanel (Anexo A) |
| 13 | [IA, fluxos e agentes](13-ia-fluxos-agentes.md) | Âncora | Motor de fluxos, cron de fluxos e watchdog, responder e tools, perfis de agente, KB/RAG, simulador. Seção 14 = decisões da operação |
| 14 | [Segurança e dados](14-seguranca-e-dados.md) | Sextante | RLS e grants, segredos e rotação de chave, papéis por rota, SSRF, LGPD, tipos gerados do banco e drift de schema (causa do #143/#144) |
| 15 | [Plataforma e operação](15-plataforma-e-operacao.md) | Sextante | Inbox durável de **mensagens**, API pública V2, webhooks de saída, alertas e crons versionados, CI na `v2`, staging, deploy e rollback, registro de migrations |
| 16 | [Comparativo Voll 360 × Fortics](16-comparativo-voll360-fortics.md) | Pesquisa | Onde estamos à frente e atrás; lacunas de backend |
| — | [Inventário de rotas](inventario-rotas.md) e [de tabelas](inventario-tabelas.md) | Prisma | Mecânico. ⚠️ RLS em laço `DO`/`EXECUTE` gera falso "sem RLS". Vale o banco live (PRD 14, Anexo A) |
| — | [Modelo dos PRDs](_MODELO.md) | — | Estrutura e regras (inclui a REGRA DO DONO sobre negócio) |

## ⚠️ Urgente na V1 (produção hoje, fora da regra de "só V2")

São riscos de **segurança ou perda de dados** que já existem na `main`.

| Item | PRD | Risco | Proposta |
|---|---|---|---|
| **WH-01/WH-02** | 15 | Mensagem do cliente vinda da Meta é gravada **depois** do 200, em `after()`. Um restart ou deploy, ou erro do banco, **perde a mensagem** sem retry. | Inbox durável de mensagens, como o de status (#134), em modo sombra antes de ligar |
| **R-1** | 14 | `ai_config` (`api_key`, `elevenlabs_api_key`, prompt) é **legível e gravável por qualquer membro**, inclusive viewer, direto pelo PostgREST. Linhas antigas têm chave em texto puro. | Policy nova + REVOKE de colunas (migration). Cifrar o legado. |
| **R-2** | 14 | `whatsapp_config`: a 153 fechou a escrita dos segredos, mas a **leitura** continua aberta a qualquer membro (`access_token`, `app_secret`, `verify_token`, `waha_api_key`). | `REVOKE SELECT` + `GRANT SELECT` por coluna |
| **SG-4** | 14 | `dispatch-kick` monta a URL do cron pelo `Host` da requisição e **envia o `CRON_SECRET`** para ela. | Usar a URL de env confiável, como o `tick-chain` |
| **#150** | 13/14 | Token DDM em texto via importação de fluxo; erro da DDM tratado como sucesso. | **PR pronto**: merge e deploy |
| **P-01/P-02** | 15 | Nenhum alerta ativo; crons não versionados. | Lista de crons versionada e alertas mínimos |

## Ordem de implementação recomendada (V2)

1. **Bases que destravam o resto** (PRDs 14 e 15):
   - tipos gerados do banco, checagem de drift e registro de migrations;
   - CI rodando nos PRs da `v2`;
   - staging oficial.
2. **Durabilidade e segurança:**
   - inbox de mensagens (15) e webhooks de saída (15);
   - RLS e segredos (14);
   - alertas (15).
3. **Disparador** (11): bancada em staging → ligar o claim em lote e o tick encadeado → heartbeat → operações em lote.
4. **Worker F2** (12), depois de 3 e com a bancada S3/S7/S9 aprovada.
5. **IA e fluxos** (13): cron de fluxos, watchdog, KB sem leitura total, providers, PII em eventos.
6. **API V2** (15): template e janela de 24 h, canal, erros estáveis, rate limit compartilhado.

## Numeração de migrations (reserva)

| Faixa | Uso |
|---|---|
| ≤ 193 | já em produção (V1) ou na V2 (175–182) |
| 194–198 | PRD 11 |
| 199 | PRD 12 (leases e bucket do worker; pode ocupar 199a/b) |
| 200, 200b | PRD 14: R-1/R-2. **Se forem para a V1 agora, ficam com esses números.** |
| 201–209 | PRD 15: inbox de mensagens, webhooks de saída, registro de migrations |
| 210–219 | PRD 13 |
| 220+ | PRD 14 (demais) |

O orquestrador confirma o número no momento do PR, sempre conferindo a `main` e a `v2`.

## Perguntas ao dono (consolidadas)

**Prioritárias** (destravam a V1 urgente):
1. Corrigir **já na V1**: WH-01/02 (inbox de mensagens), R-1/R-2 (segredos legíveis) e SG-4 (`CRON_SECRET`)?
2. **Alguém lê `whatsapp_config` ou `ai_config` direto pelo Supabase** com a anon key (script, BI, planilha)? (R-1/R-2)
3. O **token DDM antigo** já foi revogado na DDM? (#150)
4. **Canal de alerta e plantão:** Slack, grupo de WhatsApp ou e-mail? Quem fica de plantão e em que horário? (PRD 15)
5. Acesso ao **crontab real**, ou print do agendador do EasyPanel, para versionar os crons. (PRD 15)

**Infra e worker** (PRDs 12 e 15):

6. Como o app é construído no EasyPanel (Dockerfile, Nixpacks, Passenger)? Dá para sobrescrever o comando e o *grace period* por serviço? Qual o timeout do proxy?
7. Quantos números a 80/s **ao mesmo tempo** no pico?
8. Um Supabase de staging com o compute do alvo, só para a bancada (custo mensal), está autorizado?
9. **Failover** automático cron ↔ worker ligado por padrão (recomendado)?
10. Aceita a perda máxima de ~80 a 100 itens em voo, que viram "incertos" e **nunca são reenviados**, num crash do worker?
11. Usamos o `omnichannel-v2-desenvolvimento` como **staging oficial**?
12. Aceita rodar o inbox de mensagens em modo **sombra** por 3 a 7 dias antes de ligar?

**Segurança e LGPD** (PRD 14):

13. **Blacklist global entre contas** (M-6/A6/IA-23): manter global ou separar por conta?
14. Papéis: viewer pode enviar mensagem? Quem baixa exportações? `GET api-keys` só para admin ou acima?
15. LGPD: anonimizar contato mantendo o hash na blacklist? Quem é o encarregado? Há contrato de operador com os provedores de LLM?
16. Rotação da `ENCRYPTION_KEY`: janela de manutenção aceitável? Onde guardar a chave aposentada?
17. Rate limit compartilhado no **Postgres** (recomendado) ou no Redis?
18. CSP: aceita 1 semana só em modo report antes de bloquear?
19. Credenciais do projeto antigo (`rpjyrs…`): ainda ativas?

**Disparador e API** (PRDs 11 e 15):

20. Reenvio e cancelamento em lote: só owner ou admin também? Teto por operação (sugestão: 20.000)?
21. Itens "incertos": permitir reprocesso humano, com risco de duplicar, ou só reportar?
22. API v1 fora da janela de 24 h: recusar com `outside_window` e exigir template explícito (proposto)?
23. Escopos sem rota (`messages:read`, `contacts:*`, `conversations:read`): implementar ou esconder?
24. Eventos de webhook de saída que os integradores precisam?
25. Copiar a mídia recebida para o Storage, para não depender dos ~30 dias da Meta?

**IA** (PRD 13):

26. Versão do agente × KB: fixar o **conteúdo** dos arquivos ou só o hash?
27. RAG vetorial agora, ou KB com teto mais RAG externo opcional?
28. Claude, Gemini e Hermes sem ferramentas: manter ou restringir agentes com ferramentas à OpenAI?

**Produto** (PRD 16; só entram se o dono decidir):

29. **Régua de cobrança contínua** (PRD 17) e **voz/WhatsApp Calling** (PRD 18) entram na V2?
30. O objetivo é **substituir** o Voll 360 e/ou a Fortics?

**Decisões da operação** (negócio: registradas como risco técnico, sem PR). Ver PRD 13 §14 e a seção 4.1 dos PRDs 14 e 15.
- Acordo efetivado por frase do texto da IA (IA-02).
- Fallback "Ben".
- Encerramento automático por tabulação.
- Handoff do cliente que xinga.
- Conversa nova × reutilizada (Meta × WAHA).
