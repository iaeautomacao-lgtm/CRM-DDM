# PRD 16 — Comparativo com Voll 360 (Voll Solutions) e Fortics: lacunas de backend para a V2

**Data:** 08/10/2026 · **Fonte:** pesquisa só com material público (sites oficiais, documentação, PDF comercial, Reclame Aqui). "Não encontrado" significa que a fonte pública não confirma — não que não exista. **Confirmar com o comercial das duas antes de qualquer decisão de substituição.**

## 1. Quem são
- **Voll 360 = Voll Solutions** (São Paulo, Meta Business Partner). A página de cobrança mostra **a DDM entre os clientes**. Produtos: Voll 360° (tela única do atendente, tabulação, retornos, Kanban), Voll Flows (bots/agentes no-code), Voll Workflows (automação por eventos), Voll AI Suite (Copilot, Quality, Sentiment), WhatsApp Business API e **WhatsApp Business Calling API**. Fontes: [home](https://vollsolutions.com.br/), [cobrança](https://vollsolutions.com.br/cobranca/), [Voll 360](https://vollsolutions.com.br/solucoes/voll-360/).
- **Fortics** (fundada em 2003, +2 mil clientes). Ecossistema: Chat Center (ex-SZ.chat), Voz (ex-Fortics PBX), Contact Center, IA, Campanha e Channel Connect (BSP oficial da Meta). Fontes: [home](https://ai.fortics.com.br/home), [docs](https://docs.fortics.com.br/), [planos](https://ai.fortics.com.br/planos?hsLang=br), [PDF comercial](https://ai.fortics.com.br/hubfs/%5B8DH%5D%20Arquivos%20site/Fortics_Apresentacao_Comercial.pdf).

## 2. Matriz (resumo)
| Funcionalidade | Voll 360 | Fortics | Nosso CRM | Situação |
|---|---|---|---|---|
| WhatsApp API oficial | Sim | Sim (BSP próprio) | Sim, Cloud API direta, vários números | Paridade (sem margem de BSP) |
| WhatsApp não oficial | não encontrado | não encontrado | WAHA preparado | Vantagem tática (risco de banimento) |
| Instagram/Messenger, webchat | Sim | Sim | Webchat sim; Instagram/Messenger falta configurar | Quase paridade |
| SMS / e-mail | Sim / Sim | via terceiro / Sim | Não | **Atrás** (fallback da régua) |
| Telefonia SIP/VoIP, URA, gravação | Sim | Sim | Não | **Atrás — ALTA** |
| WhatsApp Calling API | Sim | Sim | Não | **Atrás** (entrada mais barata em voz) |
| Discador automático | citado, sem modos | campanhas de discagem (modo não confirmado) | Não | **Atrás — ALTA** |
| Disparo em massa (templates) | Sim | Sim | Sim (Meta + WAHA) | Paridade |
| Vazão por número, limite por qualidade, pausa automática, catálogo de erros, rotação de templates, previsão de término | não encontrado | não encontrado | **Sim** | **À frente** |
| Importação 100k + dedupe | não encontrado | importação em lote | Sim | À frente em escala |
| Status por envio | recebido/lido/clicado/respondido/**pago** (via Cobmais) | pendente/enviado/entregue/**clicado**/erro | enviado/entregue/lido/erro + 131026 provisório | Faltam **"clicado"** e **"pago"** |
| **Régua de cobrança contínua** | Sim, via Cobmais (datas/status, boleto/Pix) | via workflows | Só campanhas pontuais | **Atrás — ALTA** |
| Custo Meta por categoria / carteira / alerta de saldo | repasse | carteira, recarga, relatório por categoria | Não | **Atrás — MÉDIA** (Meta cobra Utility desde 01/10/2026) |
| Flow builder / simulador | Voll Flows (testes em tempo real) | fluxos | Flow builder + simulador | Paridade/à frente |
| Agentes LLM | OpenAI, Claude, Gemini, DeepSeek, Ollama | OpenAI, Gemini | OpenAI, Gemini, Claude | Paridade |
| Perfis de agente versionados | não encontrado | duplicar/exportar | Sim | **À frente** |
| Ferramentas do agente | API de integração | Workflows, MCP, **SQL externo** | HTTP reutilizável com credencial cifrada + MCP | Paridade/à frente |
| Proteções (xingamento, loop, pessoa errada, opt-out) | não encontrado | não encontrado | Sim | **À frente** (crítico em cobrança) |
| Integração de cobrança | Cobmais (régua, boleto/Pix) | ERP em cases | API DDM (localizar, débitos, **efetivar acordo**) | À frente em acordo; atrás em conectores de mercado |
| STT de áudio recebido | Sim | Sim | Não | **Atrás — MÉDIA** (devedor manda muito áudio) |
| Copilot / QA automático por IA | Sim / Sim (Quality AI) | resumo/sugestão | parcial (tabulação sugerida, DDM Intelligence) | **Atrás — MÉDIA** |
| Filas, SLA, supervisão, tabulação | Sim | Sim (pausas com motivo) | Sim (tabulação com IA) | Paridade; faltam **pausas/presença** |
| Permissões granulares, SSO, restrição por IP | IP | SSO, permissões por equipe | 5 papéis fixos com RLS | **Atrás — MÉDIA** |
| API pública | sem doc pública | REST v4 + OpenAPI | v1 + OpenAPI + idempotência | Paridade/à frente |
| **Webhooks de saída** | não encontrado | **15 eventos** | Não (só entrada) | **Atrás — ALTA** |
| BI / exportação | relatórios | BigQuery (premium) | API de relatórios | Paridade |
| LGPD operacional (base legal por envio, direitos do titular) | declaração | base legal automática | RLS, AES-GCM, SSRF | **Atrás** |
| Infra / alta disponibilidade / status page | não encontrado | redundância, pentests, status page | 1 VPS (4 vCPU/16 GB) + Supabase Pro | **Atrás — ALTA** (ponto único de falha) |
| Preço | não público | R$ 844–1.695/mês + R$ 40–48 por mil mensagens extras | próprio | Sem licença por mensagem |

## 3. Onde estamos à frente
1. **Motor de disparo** (vazão por número, limite por qualidade, pausa automática, catálogo de erros, 131026 provisório, previsão de término) — nenhum dos dois documenta.
2. **IA de cobrança** com proteções, opt-out obrigatório, perfis versionados, simulador e **acordo efetivado direto na API da DDM**.
3. **API com idempotência** e segredos cifrados.
4. **Custo**: sem licença por mensagem/agente.

## 4. Onde estamos atrás — e em qual PRD entra
| Sev. | Lacuna | Entra em |
|---|---|---|
| ALTA | **Régua de cobrança contínua** (D-x/D+x do vencimento, aging, status; para sozinha quando paga/fecha acordo/opt-out; fallback de canal) | **PRD 17 (novo)** |
| ALTA | **Sincronização de pagamento/acordo** para não cobrar quem já pagou; métrica "pago" | PRD 17 |
| ALTA | **Webhooks de saída** assinados (HMAC), com fila de retentativas e dead-letter | PRD 15 |
| ALTA | **Alta disponibilidade**: separar web e worker, healthchecks, backups testados, status page, runbook | PRD 12 + PRD 15 |
| ALTA | **Voz**: fase 1 WhatsApp Calling API (CDR, gravação/transcrição opcionais); fase 2 SIP/discador externo | **PRD 18 (novo, a decidir)** |
| MÉDIA | **Custo Meta** por categoria (campo `pricing` dos status), teto por campanha, alerta de saldo | PRD 11 |
| MÉDIA | **STT de áudio**, copilot, QA automático | PRD 13 |
| MÉDIA | Pausas/presença do agente; permissões granulares; SSO/2FA/IP | PRD 14 + PRD 15 |
| MÉDIA | LGPD operacional (base legal por contato/envio, direitos do titular) | PRD 14 |
| MÉDIA | SMS/e-mail como fallback da régua | PRD 17 |
| MÉDIA | Status "clicado" (links rastreados — já há UTM) | PRD 11 |

## 5. Perguntas ao dono
1. Vamos criar a **régua de cobrança** (PRD 17) na V2? Quais sistemas informam pagamento/acordo hoje (API DDM, Cobmais, arquivo)?
2. **Voz** entra no escopo da V2 (WhatsApp Calling primeiro) ou fica para depois?
3. O objetivo é **substituir** Voll 360 e/ou Fortics? Isso muda a prioridade de voz, SMS/e-mail e SSO.
4. Há contrato de SMS/e-mail que possamos usar como fallback?
