# Entrega ampliada — correções do CRM

Data: 02/10/2026. Base: main, commit 51c379f, que corresponde à versão atualizada recebida. Branch: fix/crm-reliability-security. Cadastro aberto confirmado pelo usuário para contas independentes. Esta entrega deve ser revisada e homologada antes da implantação.

## Implementação e rastreabilidade

| Requisitos | Alteração entregue | Validação restante |
| --- | --- | --- |
| CRM-01/09/10 | WAHA e rotas operacionais exigem segredo; eventos ack seguem transições monotônicas; segredo ausente bloqueia execução | Conferir versão WAHA, configuração de cabeçalhos e payloads reais |
| CRM-02/08 | Proxy VoIP com sessão, papel e conta; Go exige segredo interno, filtra sessões/SSE/QR e valida áudio por HTTPS, allowlist, IP/DNS, tamanho e timeout | Testar proxy streaming, SQLite existente, sessões e mídia em homologação |
| CRM-03 | RPCs de coordenação restritas ao service_role, políticas de tabelas internas | Conferir ACLs efetivas do banco instalado |
| CRM-04/13 | Logs com sessão owner/admin e filtros por conta; sem Basic Auth no navegador; RPCs específicas por conta | Teste integrado com duas contas; registros globais sem account_id ficam fora desta tela |
| CRM-05 | Bucket chat-media privado; referência estável via API autenticada e assinatura curta para provedores; leitura de URLs antigas normalizada | Inventariar caminhos antigos, conferir políticas efetivas e autorização por conversa/agente; conta isolada não substitui esse último critério |
| CRM-06/07 | Nest exige perfil atual e conta exclusiva do serviço legado, aplica papel; preparação bloqueia consumidores e retomada não recria fila; chave única por mensagem e claim SQL com limites compartilhados | Banco public legado deve ser exclusivo de uma conta; não há migração completa desse serviço para multitenancy; validar seu schema divergente do bootstrap |
| CRM-11, CRON-09/10 | Claim SQL considera enviados e em voo, limita concorrência por canal; um lote por campanha/tick, reserva de cadência persistida | Quota comum entre fila, manual/API, flows e IA ainda não foi implementada |
| CRM-12/14 | Compose dev em loopback, Dockerfile frontend; CI de CRM, ambos auxiliares e Go | Build dos containers e topologia de produção não foram validados |
| UX-01/02/03/05 | Tratamento de 401, próximo destino seguro, recuperação e callback, erro de perfil recuperável e proteção contra resposta antiga | Testes de navegação com sessão real e expiração |
| UX-04/07/08 | Menu por papel, página de segurança pessoal, menu móvel auxiliar, labels/autocomplete/alertas e textos | Revisão visual, teclado, leitor de tela e contraste em dispositivos reais |
| UX-06 | Save serializado, dirty preservado quando há nova edição, ativação aguarda save, links internos aguardam save, beforeunload | Voltar/avançar do navegador e recuperação persistente de rascunho não estão cobertos |
| DEC-01 | Cadastro aberto; informa conta independente e diferencia sessão imediata de confirmação por e-mail | Validar configurações de confirmação e convites no Supabase |
| CRON-01 | GET de cron apenas diagnostica; execução por POST autenticado; health não drena filas | Atualizar agendadores que hoje usam GET |
| CRON-02/03/08 | Resultado ambíguo não volta automaticamente à fila; aceitação externa com falha local preserva ID e retorna 202; sem fallback silencioso de sucesso | Reconciliação operacional necessária; não há recuperação automática de todo resultado externo desconhecido |
| CRON-04/05 | Claims condicionais/SQL, fase preparando, retomada controlada e worker explícito cron/polling/disabled | Próxima abertura/fuso/janelas noturnas e recuperação de preparação após crash continuam pendentes no legado |
| CRON-06 | Conclusão e outbox na mesma transação, claim com lease, backoff e chave de evento estável | Receptor deve deduplicar Idempotency-Key; crash após aceite remoto pode repetir callback |
| CRON-07 | Recibos antecipados persistidos/reaplicados, transições monotônicas e métricas únicas; falha assíncrona não reabre envio | Classificador assíncrono completo e correlação por tentativa permanecem pendentes |
| CRON-11 | IA global disputa intenção persistente por conta/conversa/mensagem/nó | Intent interrompido requer investigação; validar debounce concorrente e limites da janela de histórico |
| CRON-12 | Timeouts Meta/WAHA/IA/ferramentas, lease renovado, orçamento de início de trabalho, ordenação de campanhas, timeout filtrado antes do limite de flows e backoff de atribuição | Circuit breaker, jitter, quota global e checkpoints completos ainda pendentes |

## Migrações e ordem de implantação

1. Homologar com backup e schema atual. Interromper consumidores e agendadores durante a troca. Não resetar itens enviando por idade.
2. No CRM wacrm, aplicar em ordem 118 até 125 sobre as migrações anteriores existentes. 120 cria RPCs de logs por conta; 121 torna chat-media privado; 122 outbox/intenções IA; 123 progresso de cron; 124 ledger de envio; 125 recibos antecipados. Testes SQL usam PostgreSQL embarcado e não substituem teste com conexões concorrentes e PostgREST reais.
3. Publicar aplicação e migração 121 em uma janela coordenada: o código anterior usa URLs públicas. Conferir pastas account-UUID e uploads antigos antes de fechar o bucket.
4. Somente se o Nest legado estiver ativo, reconciliar o schema public e aplicar disparador/database/004_dispatch_safety.sql nele. A migração aborta se disp_message_queue não existir; não renomeia tabelas/views automaticamente. Definir DISPATCH_SINGLE_ACCOUNT_ID e confirmar que todos os dados public pertencem a essa conta. Não apontar consumidores dos dois schemas para uma fila comum sem adaptar e validar o mesmo protocolo.
5. No Go, configurar VOIP_SERVICE_SECRET e VOIP_AUDIO_ALLOWED_HOSTS (hosts exatos de áudio). Configurar VOIP_URL e o mesmo segredo no Next. Sessões antigas não mapeadas são bloqueadas: após conferir o dono de cada sessão no SQLite, preencher session_accounts(session_id, account_id). Não atribuir automaticamente todas as sessões à primeira conta. O worker legado de ligações precisa da adaptação ao novo contrato autenticado antes de ser habilitado.
6. Configurar CRON_SECRET e WAHA_WEBHOOK_SECRET no CRM; WEBHOOK_SECRET/CRON_SECRET no Nest. Definir QUEUE_WORKER_MODE explicitamente; padrão cron. Configurar cabeçalhos dos webhooks WAHA. Atualizar crons para POST, remover acionamentos redundantes e conferir apenas um modo de consumo por fila.
7. Todos os clientes de POST /api/v1/whatsapp/send e /api/whatsapp/send devem enviar Idempotency-Key com 8–128 caracteres por intenção. O browser envia uma UUID por requisição e preserva a chave no retry de autenticação. Repetir a mesma chave/conteúdo retorna a resposta registrada; mudar conteúdo retorna 409. Reserva interrompida não expira para novo envio. Integradores antigos sem cabeçalho recebem 400: coordenar a atualização antes de publicar.
8. Fazer os testes de duas contas, dois consumidores, timeout após aceitação, falha de confirmação, callback/replay, login e mídia. Liberar gradualmente; comparar IDs externos, itens pendentes de reconciliação e taxas por canal.

## Reconciliação operacional

Investigar itens enviando, send_operations reserved e ai_reply_intents antes de liberar qualquer tentativa nova. Correlacionar conta, fila/conversa, chave de operação e message ID nos logs do provedor. Não excluir reservas para “destravar” o processamento sem verificar se o envio foi aceito. Se há aceite comprovado, reparar apenas o registro local e métricas com os RPCs idempotentes; reaplicar recibos por replay_dispatch_receipts. Se não há prova conclusiva, manter resultado desconhecido e escalar para decisão operacional. Preparação interrompida e filas legadas anteriores ao message_index precisam de revisão, sem reenfileiramento cego.

Tabelas de ledger, intenções e recibos exigem política de retenção após reconciliação; este PR não remove automaticamente reservas. Receptor do callback deve persistir a chave campaign.completed:UUID antes de produzir efeitos.

## Validação local

- CRM: 52 arquivos de teste, 567 testes aprovados e 1 ignorado; inclui 12 testes novos de SQL/idempotência e isolamento de logs. Typecheck aprovado.
- Backend Nest e frontend auxiliar: builds aprovados.
- Go: go mod tidy e go test ./... aprovados. go.mod atualizado para o mínimo resolvido pelas dependências.
- Lint e build do CRM: aprovados; o build usa valores fictícios de CI, sem acesso a produção. Next.js ainda emite aviso de depreciação do nome middleware.
- Sem envios reais, migrações/alterações de produção ou merge. Containers e homologação integrada não executados.

Os 34 requisitos não foram encerrados integralmente: a matriz distingue contenção/implementação de critérios ainda pendentes. O PR unifica o código e a documentação para revisão; não declara garantia de entrega exatamente uma vez nem identifica a causa real do incidente sem logs de produção.
