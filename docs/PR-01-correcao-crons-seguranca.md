
> Registro histórico da primeira entrega. O escopo e as instruções atuais estão em [PR-02-entrega-e-homologacao.md](./PR-02-entrega-e-homologacao.md); inclusive os logs agora usam sessão individual, e não Basic Auth.

# Entrega 01 — Segurança operacional e contenção de envios duplicados

Esta entrega inicia a implementação do [PRD unificado](./PRD-unificado-correcao-crm.md), com foco nos caminhos de envio duplicado, carga operacional e acesso aos endpoints relacionados. O PRD completo continua aberto: nenhum ID foi marcado como concluído sem homologação e configuração efetiva verificadas. Os itens com mudanças estão registrados como Em validação parcial.

## Comportamento implementado

- O health check consulta diagnóstico GET do disparador e dados de flows; não dispara os respectivos crons. O cálculo DDM com cliente real foi retirado do diagnóstico. A URL do ambiente precisa ser explícita.
- Itens em envio não são recolocados automaticamente na fila por idade. Resultado de transporte desconhecido ou aceitação externa com falha local permanece reservado para reconciliação; não provoca outro POST automático.
- Reivindicação Next.js é feita por RPC que verifica estado da campanha, limite horário incluindo reservas em andamento, concorrência por canal e quota compartilhada opcional.
- Há até quatro tarefas simultâneas por processo, até quatro reservas em andamento por canal por padrão e lote lógico de até 100 itens por tick. O teto por canal pode ser configurado na tabela administrativa. As reservas desconhecidas também ocupam capacidade até serem reconciliadas.
- O próximo lote é reservado no banco com base na execução real; ticks extras não ignoram a pausa.
- Campanhas permanecem em preparando até inserir a fila e registrar métricas. Uma falha tratada devolve a campanha a rascunho; um processo encerrado abruptamente exige revisão da preparação.
- Conclusão usa o mesmo bloqueio de campanha dos claims e considera itens em envio/pausados/retry. Uma invocação vence a conclusão; o callback é aguardado e verifica HTTP, com chave estável para deduplicação no receptor.
- Confirmação local repetida do mesmo ID externo não duplica log nem métrica. Eventos Meta de fila avançam em transação, ignoram regressões e não transformam falha assíncrona em novo envio automático.
- Manual/API retornam 202 com ID externo e indicação de reconciliação quando o provedor aceita e a gravação local falha. Flows/automations retornam o recibo aceito com indicação de pendência, em vez de fingir falha de envio.
- Chamadas principais Meta e WAHA receberam deadline de 30 segundos. Timeout continua sendo resultado desconhecido para envios.
- WAHA exige segredo no receptor e configura customHeaders no emissor. Recebimento de message.ack e avanço monotônico dos estados foram ajustados conforme o [contrato oficial WAHA](https://waha.devlike.pro/docs/how-to/events/).
- NestJS recusa crons/webhooks sem segredo, possui modo de worker explícito e claim condicional. Após tentativa externa, erro local/transporte não reagenda automaticamente a operação.
- Logs administrativos perderam as credenciais padrão. RPCs internas identificadas perderam permissão de execução para navegador.
- O disparador limpa cookie e armazenamento no 401, preserva erro de login e não usa cookie existente para expulsar o usuário da tela pública. Login principal preserva destino seguro; recuperação vai ao painel da sessão existente; callback inválido aparece na tela.
- Compose de desenvolvimento publica portas em loopback; frontend ganhou Dockerfile para desenvolvimento. CI passou a verificar builds dos dois serviços auxiliares além do CRM principal.

## Implantação coordenada

1. Inventariar agendadores/consumidores efetivos, registrar versões e preparar backup e homologação. A branch parte da main em 34a55f9.
2. Confirmar migrações anteriores, especialmente 040 (colunas account_id), 075, 088, 089, 091 e 112; aplicar **118_dispatch_safety.sql** e **119_dispatch_status_transitions.sql** antes do código. Conferir grants e schema cache. Não basta editar arquivos SQL antigos.
3. Configurar WAHA_WEBHOOK_SECRET no CRM e x-webhook-secret nas sessões WAHA existentes antes de ativar o receptor. Novas sessões configuram o header automaticamente; a aplicação recusa configuração de webhook incompleta.
4. Configurar DDM_LOGS_USER/DDM_LOGS_PASSWORD explícitos, CRON_SECRET e NEXT_PUBLIC_APP_URL. NestJS requer WEBHOOK_SECRET e CRON_SECRET. Definir QUEUE_WORKER_MODE como cron, polling ou disabled; padrão cron. O Compose de produção precisa receber esses valores.
5. Definir os limites por canal em wacrm.dispatch_channel_limits com acesso administrativo. Sem linha, concorrência padrão 4 e limite horário da campanha; não se deve afirmar que a quota agregada está configurada. O controle desta entrega cobre a fila do disparador Next.js, não todas as modalidades de envio.
6. Classificar os itens existentes em enviando e agendado com recibo externo antes da retomada. Com ID externo aceito, reconciliar confirmação local; sem evidência suficiente, manter pendente. Não converter todos para agendado.
7. Identificar campanhas em preparando após interrupção abrupta e revisar a fila parcial antes de reiniciar. Validar retomada, cancelamento e publicação em homologação.
8. Implantar gradualmente, acompanhar latência/429, fila, resultados desconhecidos e callbacks. Preservar fechamento de acesso no rollback; versões antigas que resetam enviando não devem retomar o mesmo banco sem coordenação.

## Validação

As verificações usam mocks e PostgreSQL embarcado PGlite, sem mensagens, crons ou banco reais. Testes SQL cobrem claim único, campanha em preparação, reservas/quota compartilhada, pausa real, conclusão com trabalho em andamento, confirmação idempotente, ACLs e estados repetidos/fora de ordem. PGlite não substitui ensaio com múltiplas conexões no Supabase efetivo.

Validação local concluída em 01/10/2026:

| Verificação | Resultado |
| --- | --- |
| Suite CRM (50 arquivos) | 555 testes aprovados; 1 teste existente ignorado |
| SQL 118/119 após os ajustes finais | 11 testes aprovados no PostgreSQL embarcado |
| Typecheck CRM | Aprovado |
| Lint CRM | Sem erros; avisos existentes permanecem |
| Build CRM Next.js 16 | Aprovado com variáveis fictícias de CI |
| Build backend NestJS | Aprovado |
| Build frontend auxiliar Next.js 14 | Aprovado |
| Diff e links locais da documentação | Validados |

Permanecem pendentes revisão visual, teste com múltiplas conexões/instâncias em homologação, containers e conferência do ambiente de produção. Nenhum envio real foi executado.

## Critérios ainda pendentes e próximas entregas

- Diagnóstico do incidente em produção e verificação das permissões/configurações efetivas.
- CRM-02/08: autenticação/isolamento e downloads seguros do VoIP. CRM-05: migração coordenada dos anexos privados. CRM-06: autorização por conta/papel no NestJS.
- CRM-04/13: sessão administrativa e escopo por conta para logs; remover Basic armazenado no navegador. Remover defaults não fecha esses critérios.
- UX-02/04/06/07 e demais critérios de UX-08: recuperação de perfil, menu por capacidade, salvamento seguro do editor, interface móvel e revisão visual/acessibilidade. DEC-01: política de cadastro.
- CRON-02/03/08: outbox de operações e tentativas duráveis, idempotência de requisições repetidas e reconciliação completa com dono/lease. Esta entrega contém reenvio cego, mas não oferece recuperação automática nem envio exatamente uma vez.
- CRON-04/CRM-07: confirmar se NestJS e Next.js compartilham schema/fila; padronizar o protocolo entre consumidores ativos. Adiamento ainda precisa de próxima abertura correta, fuso explícito e janela que cruza meia-noite.
- CRON-05: geração/token de preparação e recuperação persistente após crash. CRON-06: outbox persistente de callbacks; um crash após concluir e antes de notificar pode perder o callback. Receptor deve respeitar a chave de idempotência.
- CRON-07: classificador Meta síncrono/assíncrono verificado e vínculo de eventos à tentativa, incluindo recibos que chegam antes da persistência do ID externo. Nesta etapa, falhas assíncronas são conservadoramente finais para retry automático, sujeitas a revisão.
- CRON-09/10/12: quota que inclua envio manual/API, flows e IA; reservas completas de tentativas, limites de todas as integrações, fairness, jitter, backoff/circuito e checkpoints de retomada. Deadline não equivale a proteção completa de carga.
- CRON-11: vencedor persistente para debounce da IA global.
- CRM-12/14: validação real de containers, persistência, proxy e VoIP/Go no CI. O Dockerfile adicionado é para o Compose de desenvolvimento.

## Registro de revisão

| Item                                                     | Estado           |
| -------------------------------------------------------- | ---------------- |
| Implementação local da entrega                           | Em validação     |
| Homologação com várias instâncias e provedores simulados | Pendente         |
| Migrações/configuração em produção                       | Não executadas   |
| Política de cadastro                                     | Decisão pendente |
| Fechamento integral do PRD                               | Pendente         |
