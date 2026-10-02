# PRD 03 — Crons, duplicação de envios e sobrecarga de integrações

> **Histórico:** este PRD foi consolidado no [PRD unificado — Correções do CRM](./PRD-unificado-correcao-crm.md). Usar o documento unificado para implementar e atualizar o progresso.

| Campo                   | Valor                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| Data                    | 01/10/2026                                                                                                    |
| Status                  | Investigação estática concluída para os caminhos abaixo; correções ainda não implementadas                    |
| Sintoma reportado       | Duplicação de envios WhatsApp/Meta e sobrecarga em sistemas integrados                                        |
| Escopo                  | Crons, filas, callbacks, envio manual/API, webhooks Meta, IA e consumidores auxiliares                        |
| Documentos relacionados | [PRD 01](./PRD-correcao-auditoria-crm.md) e [PRD 02](./PRD-login-interface-usabilidade-crm.md)                |
| Objetivo                | Reduzir execuções redundantes, evitar reenvio de operações já aceitas e controlar a carga real por integração |

## 1. Conclusão da investigação e limites

Há caminhos concretos no código que permitem repetir operações externas ou ampliar a carga. Não é possível atribuir o incidente reportado a uma causa única sem correlacionar logs, filas, IDs Meta e agendadores ativos.

Esta investigação não executou crons, testes de stress, mensagens WhatsApp nem chamadas aos sistemas integrados. Não houve acesso ao banco, servidor, agendadores ou métricas de produção. A documentação oficial da Meta sobre códigos de erro retornou HTTP 429 durante a consulta; classificações de códigos precisam de verificação posterior, sem adotar comentários do código como contrato oficial.

Este documento registra falhas e cenários de concorrência identificáveis por leitura. Não declara duplicação observada em produção nem garante envio exatamente uma vez apenas com uma trava no banco.

### Proteções que já existem

- O processador Next.js reivindica cada item com `UPDATE` condicionado a `status='agendado'`. Duas chamadas normais concorrentes não deveriam ganhar a mesma reivindicação enquanto o status continuar `enviando`.
- O início de campanha Next.js também usa uma alteração condicional para evitar dois inícios normais de rascunho/agendamento.
- Automations e a retomada de flows atrasados têm alterações condicionais de status antes do processamento.
- O webhook Meta ignora duplicidade de mensagem recebida quando o índice único da migração 088 está aplicado e a inserção retorna `23505`.

Essas proteções não cobrem todos os efeitos externos, a recuperação de envio ambíguo, a finalização de campanha, a carga agregada ou o worker NestJS. Repetir uma chamada de cron não equivale necessariamente a repetir a mesma mensagem; pode também antecipar novos envios e aumentar a carga.

## 2. Prioridades e evidência

**P0:** conter caminhos com reenvio de operação já aceita ou competição de consumidores. **P1:** corrigir cadência, retries, finalização e observabilidade na sequência.

| ID      | Achado                                                            | Prioridade | Evidência / condição                                                                                      |
| ------- | ----------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| CRON-01 | Health check aciona crons reais                                   | P1         | Confirmado no código; cada execução gera trabalho operacional adicional                                   |
| CRON-02 | Itens em envio são recolocados na fila por idade                  | P0         | Confirmado no código; duplicação possível se o envio original ainda estiver ativo ou já aceito            |
| CRON-03 | Meta aceita envio, mas erro local é devolvido como falha          | P0         | Confirmado no código; nova tentativa do usuário/integrador repete o POST externo                          |
| CRON-04 | Worker NestJS não reivindica atomicamente                         | P0         | Confirmado no código; impacto depende de estar ativo e compartilhar fila/serviço                          |
| CRON-05 | Campanha fica executável antes de terminar o enfileiramento       | P0         | Corrida identificada entre início e outro consumidor/cron                                                 |
| CRON-06 | Finalização e callback não possuem vencedor único                 | P1         | Corrida identificada em invocações sobrepostas; itens em envio não entram na condição de conclusão        |
| CRON-07 | Falhas Meta assíncronas e eventos atrasados podem reabrir retries | P1         | Atualização sem condição sobre estado/ID externo atual e sem classificação de permanência                 |
| CRON-08 | Registro de sucesso possui fallback com erros não conferidos      | P0         | Confirmado no código; pode deixar item elegível à recuperação após envio real                             |
| CRON-09 | Lotes usam paralelismo e quota somente por campanha               | P1         | Confirmado no código; campanhas/instâncias podem somar carga sobre o mesmo canal                          |
| CRON-10 | Pausa inicial não limita lotes atrasados na execução real         | P1         | Confirmado no agendamento; aceleração depende de backlog e ticks adicionais                               |
| CRON-11 | Debounce da IA global não identifica o dono da resposta           | P1         | Cenário de concorrência; chamadas distintas podem passar pela mesma checagem temporal                     |
| CRON-12 | Chamadas externas e retomadas carecem de controle comum de carga  | P1         | Há chamadas sem deadline explícito, fallback por ambiente e retomada sem recuperação persistente completa |

## 3. Requisitos por achado

### CRON-01 — Separar diagnóstico de execução operacional

**Evidência:** [health check](../src/app/api/stress/run/route.ts), funções `testSmokeCronDisparador` e `testSmokeCronFlows`, chama `/api/disparador/cron` e `/api/flows/cron` reais. O mesmo endpoint roda pelo scheduler e pelo botão Rodar agora. Os testes abortam a espera HTTP após três segundos, o que não é evidência de cancelamento do trabalho no servidor. `getBaseUrl` ainda usa um domínio de produção como fallback.

**Riscos:** execução extra, aumento de carga, diagnóstico acusando timeout enquanto o cron continua e ambiente de teste apontando para produção quando a URL não está configurada. O health check também consulta a API de cálculos DDM; não é apenas uma verificação local.

**Correção necessária:**

- Tornar o health check padrão somente leitura: consultar saúde da fila, última execução e configuração sem drenar fila nem retomar flows.
- Manter execução operacional explícita em ação separada, autenticada, limitada e auditada. Não usá-la como substituto de scheduler.
- Exigir URL explícita ou origem confiável do ambiente; remover fallback silencioso para produção.
- Limitar frequência e sobreposição do próprio health check, inclusive chamadas pelo botão.
- Preferir endpoint leve de saúde do sistema externo, quando disponibilizado, a executar cálculo de um registro como monitoramento frequente.
- Atualizar [instruções de stress](../tests/stress/README.md) e mensagens da tela para refletir a ausência de efeitos operacionais no diagnóstico padrão.

**Aceite:**

- [ ] Health check padrão não faz POST de envio, não altera estado operacional de filas/flows e não dispara callbacks.
- [ ] Timeout do diagnóstico não inicia uma nova execução automática do mesmo trabalho.
- [ ] Ambiente sem URL configurada não envia diagnóstico ou segredos ao domínio de produção por fallback.

### CRON-02 — Recuperar envio ambíguo sem reenvio cego

**Evidência:** [cron](../src/app/api/disparador/cron/route.ts) transforma `enviando` em `agendado` quando `updated_at` tem mais de cinco minutos. [Processador](../src/lib/disparador/processQueue.ts) grava o timestamp no claim, mas não renova uma lease durante o envio. Os helpers [Meta](../src/lib/whatsapp/meta-api.ts) não definem deadline explícito nos POSTs de envio.

**Cenário:** A reivindica o item e o envio demora, a conexão perde a resposta ou a escrita final falha. B considera o timestamp antigo e recoloca o item na fila. B o reivindica e envia novamente. O claim original não impede esse segundo envio porque o status foi reaberto.

**Correção necessária:**

- Separar o estado de reivindicação do estado de resultado externo. Persistir tentativa, dono, lease e identificador da operação antes do envio.
- Definir deadlines e duração de lease compatíveis; renovar trabalho ativo e exigir o dono correto nas escritas finais.
- Encaminhar resultado desconhecido para reconciliação, em vez de converter automaticamente em envio novo.
- Persistir o ID retornado pela Meta assim que disponível e usar eventos/status para completar o registro local sem repetir o POST.
- Para resultado externo realmente desconhecido, documentar a estratégia de reconciliação ou revisão manual. Não presumir suporte a idempotência externa sem confirmar o contrato do provedor.

**Aceite:**

- [ ] Envio lento em andamento não pode ser reivindicado por outra execução apenas por idade.
- [ ] Queda após aceitação externa não provoca reenvio automático sem reconciliação.
- [ ] Execução antiga não sobrescreve estado pertencente a uma tentativa nova.

### CRON-03 — Diferenciar falha de envio de falha de persistência

**Evidência:** [API interna de envio](../src/app/api/whatsapp/send/route.ts) e [API pública](../src/app/api/v1/whatsapp/send/route.ts) enviam à Meta primeiro e retornam HTTP 500 se inserir a mensagem no banco falhar. O [inbox](../src/components/inbox/message-thread.tsx) mostra o envio como `failed`. Os senders [flows](../src/lib/flows/meta-send.ts) e [automations](../src/lib/automations/meta-send.ts) também lançam erro após aceitação externa e falha de registro local.

**Cenário:** a Meta recebe a mensagem; o CRM informa falha; usuário ou integrador repete a operação. Sem chave durável de idempotência da solicitação, ocorre um segundo envio real.

**Correção necessária:**

- Criar uma operação durável de saída antes do envio, com chave de idempotência vinculada à conta e ao payload.
- Repetição da mesma chave deve devolver a operação existente, sem novo envio. Payload diferente com a mesma chave deve ser rejeitado.
- Representar aceitação externa e sincronização local pendente separadamente, mantendo o ID Meta disponível para reconciliação.
- Adaptar a interface e o contrato público para não sugerir reenviar uma entrega já aceita.
- Não usar igualdade de texto como deduplicação: duas mensagens iguais podem ser intenções legítimas distintas.

**Aceite:**

- [ ] Meta aceita e o banco falha: a UI informa registro pendente/resultado apropriado, sem tratar como envio seguramente não realizado.
- [ ] Repetir a mesma solicitação com a mesma chave não gera novo POST à Meta.
- [ ] Mensagens iguais com intenções distintas continuam possíveis com chaves distintas.

### CRON-04 — Impedir competição do worker NestJS

**Evidência:** [worker NestJS](../disparador/backend/src/message-queue/message-queue.worker.ts) faz SELECT de item agendado e UPDATE somente por ID. A variável `processing` existe apenas dentro da instância. O loop inicia automaticamente fora de Vercel; [process-tick](../disparador/backend/src/message-queue/message-queue.controller.ts) também pode acioná-lo.

**Correção necessária:**

- Inventariar instâncias e decidir qual serviço consome cada fila, incluindo topologia/schema real do NestJS.
- Tornar o modo de consumo explícito: worker contínuo ou scheduler, com comportamento conhecido ao escalar réplicas.
- Usar reivindicação atômica comum no banco e identificação de dono, compatível com os demais consumidores ativos.
- Não confiar em flag em memória para exclusão entre instâncias.
- Corrigir adiamentos que deixam o item em `enviando`, conforme CRM-07 do PRD 01.

**Aceite:**

- [ ] Duas instâncias disputando o mesmo item produzem um vencedor.
- [ ] Consumidores diferentes não enviam o mesmo item por protocolos incompatíveis.
- [ ] Modo de execução e serviços ativos estão documentados no deploy.

### CRON-05 — Publicar campanha para consumo somente após preparar a fila

**Evidência:** [startCampaign](../src/lib/disparador/startCampaign.ts) altera a campanha para `em_execucao` no começo e depois faz consultas, delete de itens agendados e inserções em blocos. Outro cron já pode enxergá-la como ativa antes de existir a fila completa.

**Cenários:** outro tick encerra campanha ainda vazia; dispara callback precoce; inicia consumo de um bloco parcial; falha no enfileiramento deixa campanha ativa e incompleta. O início posteriormente regrava `em_execucao`, podendo reabrir campanha que o cron acabou de encerrar.

**Correção necessária:**

- Usar fase de preparação não consumível ou publicação transacional do lote/generation.
- Validar configuração antes da publicação; permitir recuperação idempotente de preparação parcial sem destruir itens aceitos/em envio.
- Impedir conclusão enquanto a geração estiver em preparação.
- Fazer o cron resolver a conta persistida na campanha e validar a identidade necessária, sem inferir propriedade apenas da conta atual do criador.

**Aceite:**

- [ ] Um cron concorrente durante o enfileiramento não consome nem conclui a geração incompleta.
- [ ] Falha entre dois blocos de inserção permite recuperação sem duplicar envios existentes.
- [ ] Campanha inválida não permanece apresentada como em execução após erro de início.

### CRON-06 — Concluir campanha e emitir callback com idempotência

**Evidência:** [cron](../src/app/api/disparador/cron/route.ts) verifica ausência de `agendado` e erros elegíveis, mas não contabiliza `enviando`. Depois grava `encerrada` apenas por ID e chama callback sem verificar qual execução venceu. [sendCampaignCallback](../src/lib/disparador/processQueue.ts) não mantém evento persistente de entrega; registra envio sem verificar `res.ok`.

**Correção necessária:**

- Concluir por operação atômica condicionada ao estado/generation e à ausência de preparação, envios ativos e retries pendentes.
- Criar um evento de conclusão durável e único por campanha/generation junto à transição de conclusão.
- Despachar callback por outbox, com ID estável, status HTTP verificado, timeout e retries limitados com backoff.
- Enviar ID de evento estável para deduplicação no receptor; registrar resultado e impedir que cada tick crie um evento novo para a mesma conclusão.
- Reconhecer que a entrega externa pode ser repetida após falha de confirmação; o receptor deve poder deduplicar pelo ID.

**Aceite:**

- [ ] Item em envio impede callback de campanha concluída.
- [ ] Dois ticks concorrentes geram um único evento lógico de conclusão.
- [ ] Callback HTTP 500 não é registrado como entregue e retry reutiliza o mesmo ID.

### CRON-07 — Tornar eventos de status Meta seguros para retries

**Evidência:** [handleStatusUpdate](../src/app/api/whatsapp/webhook/route.ts) lê o item, decide em memória e atualiza somente por ID. O caminho `failed` não grava classificação de `erro_permanente`. A [migração 075](../supabase/migrations/075_disparador_improvements.sql) define essa coluna como false por padrão; a [migração 089](../supabase/migrations/089_retry_transient_queue_errors.sql) reagenda erros não permanentes enquanto a campanha estiver ativa.

**Riscos:** falhas definitivas assíncronas podem gerar novas tentativas; eventos simultâneos podem inflar métricas; um evento antigo pode sobrescrever estado atualizado após a leitura e reabrir um item em situação diferente.

**Correção necessária:**

- Classificar erros Meta síncronos e assíncronos pela mesma política verificada na documentação oficial, distinguindo falha definitiva, rate limit e resultado ambíguo.
- Associar cada evento à tentativa/ID externo correto; não permitir que um evento antigo altere outra tentativa.
- Atualizar status e métricas atomicamente, condicionado ao estado anterior e à tentativa vigente.
- Deduplicar evento e impedir regressões de estados entregues/lidos por eventos atrasados sem regra explícita.
- Usar backoff com jitter e limites por integração; validar elegibilidade de retry no estado atual.
- Revisar os comentários e a política de blacklist/códigos. A interpretação dos códigos no código-fonte não substitui verificação do contrato Meta.

**Aceite:**

- [ ] Falha definitiva assíncrona não volta automaticamente à fila.
- [ ] Evento de tentativa antiga não modifica tentativa nova.
- [ ] Eventos repetidos/concorrentes não duplicam métricas nem regridem status.

### CRON-08 — Tratar erro ao registrar sucesso sem perder a entrega externa

**Evidência:** [processQueueItem](../src/lib/disparador/processQueue.ts) chama `mark_queue_item_sent`; se a RPC falha, executa três escritas de fallback sem verificar todos os erros e retorna `sent`. Se o UPDATE da fila falhar, o item pode permanecer `enviando` e cair no reset de CRON-02. A [RPC 091](../supabase/migrations/091_atomic_mark_sent.sql) também não condiciona a mudança ao dono/tentativa nem deduplica inserção de log e contador.

**Correção necessária:**

- Exigir migrações necessárias e verificar o contrato antes de habilitar envio; não mascarar erro de persistência com fallback silencioso.
- Persistir resultado externo com reconciliação durável e monitorar falhas locais.
- Tornar a RPC idempotente por operação/tentativa e condicionar a escrita ao dono correto.
- Falha de registro após envio não deve usar o mesmo caminho de erro que autoriza novo POST externo.

**Aceite:**

- [ ] Falha de registro final não transforma mensagem aceita em nova tentativa de envio.
- [ ] Repetição da confirmação local não duplica log nem total enviado.
- [ ] Deploy com migração obrigatória ausente bloqueia o consumo com erro explícito.

### CRON-09 — Controlar carga agregada por canal e integração

**Evidência:** [cron](../src/app/api/disparador/cron/route.ts) executa `Promise.all` sobre o lote completo, sem teto operacional independente. A quota é consultada por campanha e não inclui reservas em andamento. [startCampaign](../src/lib/disparador/startCampaign.ts) pode calcular `batch_size` por percentual da base.

**Correção necessária:**

- Separar lote lógico de campanha e limite de requisições simultâneas.
- Criar reservas atômicas de capacidade por canal/provedor, compartilhadas entre instâncias, campanhas, envio manual, flows e IA conforme a política operacional.
- Respeitar quota da campanha e disponibilidade restante; tratar 429/erros de limite com espera e backoff adequados.
- Aplicar limites de trabalho por tick, tempo de execução e paginação de campanhas para evitar request sem orçamento.
- Projetar fairness para que uma campanha grande não monopolize a integração.

**Aceite:**

- [ ] Campanhas simultâneas no mesmo canal respeitam o teto agregado definido.
- [ ] Lote de 5.000 itens não dispara 5.000 requisições simultâneas.
- [ ] Execuções em múltiplas instâncias não ultrapassam quota apenas por consultarem o mesmo contador antes do lote.

### CRON-10 — Aplicar pausa pela execução real, inclusive com backlog

**Precisão em relação à primeira auditoria:** a pausa não está completamente ausente. [startCampaign](../src/lib/disparador/startCampaign.ts) espaça `scheduled_at` dos lotes; o [cron](../src/app/api/disparador/cron/route.ts) consome quaisquer itens já vencidos e não persiste um próximo horário por lote efetivamente executado.

**Cenário:** scheduler parado acumula lotes vencidos; ticks repetidos consomem os lotes em cadência acelerada. A pausa inicial já ficou no passado e não limita a recuperação.

**Correção necessária:**

- Persistir próximo lote permitido pela execução efetiva e reservar essa janela de forma atômica.
- Definir explicitamente se a pausa conta do início ou término do lote; proposta: término do lote aceito/processado.
- Aplicar a mesma regra na retomada de backlog, cron extra, retry e execução manual operacional.

**Aceite:**

- [ ] Pausa de 180 segundos continua respeitada quando todos os lotes estão atrasados.
- [ ] Ticks extras não antecipam o próximo lote permitido.

### CRON-11 — Evitar respostas concorrentes da IA global

**Evidência:** [handleAiAutoResponse](../src/lib/ai/responder.ts), fora de flows, espera quatro segundos e compara idade da última mensagem, mas não verifica se a execução é dona da resposta. Duas execuções atrasadas podem observar a mesma mensagem com idade acima do limiar e continuar. O [debounce de flows](../src/lib/flows/engine.ts) possui coordenação no banco, mas usa fallback em memória se a RPC estiver indisponível.

**Correção necessária:**

- Usar identidade da mensagem/janela e reivindicação durável por conversa/canal para geração e envio.
- Persistir resultado gerado antes de enviar; retry de persistência não deve repetir consultas de débito, formalizações ou geração de resposta já concluídas.
- Evitar geração concorrente para a mesma intenção e revalidar o estado da conversa antes da operação externa.
- Exigir migração de coordenação quando necessária a múltiplas instâncias; não prometer exclusão distribuída por fallback em memória.

**Aceite:**

- [ ] Duas execuções disputando a mesma janela geram um vencedor lógico para resposta.
- [ ] Reentrega/retry da mesma intenção não repete efeitos externos irreversíveis.
- [ ] Ausência da coordenação necessária é visível e não permite silenciosamente duplicação em múltiplas instâncias.

### CRON-12 — Padronizar deadlines, retomada e proteção das integrações

**Evidência:** [helpers Meta](../src/lib/whatsapp/meta-api.ts), [WAHA](../src/lib/whatsapp/waha-api.ts), [responder IA](../src/lib/ai/responder.ts) e [proxy UTM](../src/app/api/disparador/utm/route.ts) têm caminhos de fetch sem deadline explícito. O [cron de flows](../src/app/api/flows/cron/route.ts) reivindica delayed como active antes de carregar/validar os nós; falha ou configuração inválida pode deixar a execução ativa sem retomada concluída. A reivindicação existe, mas recuperação durável e orçamento comum não estão completos.

**Correção necessária:**

- Centralizar política de timeout, cancelamento, limite de resposta e concorrência por integração.
- Tratar operações de escrita/formalização de maneira diferente de consultas: timeout não autoriza repetir efeito externo desconhecido.
- Aplicar circuito de proteção em indisponibilidade prolongada e backoff com jitter; não usar cada tick como nova rajada contra serviço falhando.
- Recuperar retomadas de flows/automations com lease e checkpoints por efeito; reexecutar todo o nó sem deduplicação pode repetir envio ou HTTP externo.
- Fazer diagnóstico usar endpoints adequados e orçamento próprio, sem competir com a carga de atendimento.

**Aceite:**

- [ ] Serviço externo lento não deixa trabalho indefinidamente ativo nem causa cascata de novas chamadas.
- [ ] Rate limit/indisponibilidade reduz carga, em vez de amplificá-la a cada tick.
- [ ] Falha após reivindicar uma retomada possui recuperação definida sem repetir efeitos já confirmados.

## 4. Diagnóstico necessário em produção — somente leitura

Antes de escolher a causa principal, coletar um intervalo curto que contenha o sintoma, sem senhas, tokens ou conteúdo completo das mensagens:

1. Listar todos os agendadores: cPanel/crontab, Supabase pg_cron, Vercel, CI, monitoramento externo e ações manuais. Registrar URL, método, frequência, timeout e política de retry.
2. Listar instâncias, ambientes e consumidores de cada fila. Verificar se desenvolvimento/homologação compartilha o banco ou aponta para a URL de produção.
3. Correlacionar mensagens repetidas por conta, canal, destinatário mascarado, intenção, `campaign_id`, ID do item, tentativa e ID Meta (`wamid`).
4. Conferir migrações aplicadas, inclusive 075, 088, 089, 090 e 091. Comentários indicando aplicação não são evidência do estado atual.
5. Localizar timestamps de claim, reset, POST externo, resposta Meta, falha de banco, webhook, conclusão e callback.
6. Medir respostas HTTP, códigos Meta, latência, simultaneidade, tamanho dos lotes e número de health checks.

| Padrão observado                                | Hipótese a verificar                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Mesmo item da fila, dois IDs Meta               | Reclaim/reset, consumidores concorrentes ou retry após resultado ambíguo                                          |
| Itens diferentes, mesmo destinatário/conteúdo   | Enfileiramento/intent duplicado, campanha distinta ou ação manual repetida; pode também ser sequência intencional |
| Mesmo ID Meta repetido somente na interface/log | Reentrega de webhook ou duplicidade de registro, não necessariamente novo envio                                   |
| Bot responde duas vezes à mesma janela          | Concorrência de IA/flow, fallback de coordenação ou triggers múltiplos                                            |
| Callback externo repetido sem mensagem repetida | Finalização concorrente ou retry do evento de conclusão                                                           |
| Pico após Rodar agora/health check              | Diagnóstico acionando cron operacional                                                                            |
| Pico ao recuperar scheduler parado              | Backlog sem cadência baseada na execução real                                                                     |

## 5. Ordem de contenção e implementação

1. Verificar agendadores/consumidores ativos e retirar fontes redundantes de execução, preservando um consumidor responsável pela fila. Nenhuma configuração de produção foi alterada nesta investigação.
2. Separar health check e cron operacional; exigir destino explícito por ambiente.
3. Corrigir resultado ambíguo e aceitação externa antes de habilitar recuperação/retries mais agressivos.
4. Implementar fase de preparação, conclusão atômica e outbox de callbacks.
5. Aplicar coordenação de fila, eventos de status e respostas IA entre instâncias.
6. Aplicar limite agregado por canal, teto de concorrência, pausa real e circuito de proteção.
7. Validar em homologação com provedores simulados e migrar com plano de recuperação dos itens existentes.

Não apagar a fila, reenviar em massa itens em erro ou aumentar timeout/limites indiscriminadamente para tratar o sintoma. Primeiro classificar envios aceitos, não realizados e desconhecidos.

## 6. Testes obrigatórios de regressão

| Teste                                         | Resultado esperado                                         |
| --------------------------------------------- | ---------------------------------------------------------- |
| Dois crons simultâneos disputam fila          | Claim único por tentativa; quota agregada respeitada       |
| Provedor aceita, resposta se perde            | Resultado ambíguo vai para reconciliação; sem reenvio cego |
| Provedor aceita e banco falha                 | Aceitação preservada; retry local não repete POST          |
| Envio ativo supera idade antiga de reset      | Dono/lease válida impede segundo envio                     |
| Campanha em preparação e outro tick           | Sem consumo parcial nem callback precoce                   |
| Dois ticks concluem a mesma campanha          | Um evento lógico de conclusão                              |
| Webhooks duplicados/fora de ordem             | Estado e métricas consistentes por tentativa               |
| Falha definitiva assíncrona                   | Sem retry operacional automático                           |
| Health check e botão Rodar agora              | Sem drenagem de fila no diagnóstico padrão                 |
| Dois lotes atrasados com pausa configurada    | Cadência real respeitada                                   |
| Duas campanhas usam o mesmo canal             | Limite compartilhado e fairness                            |
| Duas execuções de IA para a mesma janela      | Um efeito lógico, consultas/escritas externas deduplicadas |
| API externa retorna 429/5xx por período longo | Backoff/circuito reduz carga e recuperação é gradual       |

## 7. Observabilidade e conclusão

Adicionar IDs de execução, origem do acionamento, operação/tentativa e canal aos registros operacionais. Medir crons recebidos/pulados, itens reivindicados, envios aceitos, resultados desconhecidos, reconciliações, retries, mensagens duplicadas confirmadas e latência/429 por integração.

Não registrar tokens, URLs com segredos, CPFs completos ou conteúdo integral de mensagens como condição de diagnóstico.

- [ ] Causa(s) do incidente correlacionadas com evidência real, ou incertezas explicitamente registradas.
- [ ] CRON-01 a CRON-12 corrigidos e validados, ou serviço descontinuado retirado formalmente.
- [ ] Protocolos de idempotência, claim, recuperação e cadência testados sob concorrência e falhas simuladas.
- [ ] Configuração efetiva de agendadores, consumidores e ambientes registrada.
- [ ] Migrações aplicadas e verificadas; sem dependência silenciosa de fallback inseguro.
- [ ] CI e testes relevantes executados; nesta investigação não foram executados por ausência de runtime/dependências.
- [ ] Implantação acompanhada por métricas que distingam envio novo, reentrega de evento e callback repetido.
