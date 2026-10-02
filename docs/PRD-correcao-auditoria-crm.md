# PRD — Correção dos problemas identificados no CRM interno

> **Histórico:** este PRD foi consolidado no [PRD unificado — Correções do CRM](./PRD-unificado-correcao-crm.md). Usar o documento unificado para implementar e atualizar o progresso.

| Campo    | Valor                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------- |
| Data     | 01/10/2026                                                                                               |
| Status   | Proposta para implementação; correções ainda não executadas                                              |
| Escopo   | CRM Next.js/Supabase, disparador NestJS, frontend do disparador e serviço VoIP em Go                     |
| Origem   | Revisão estática do código e das configurações disponíveis nesta cópia                                   |
| Objetivo | Corrigir os 14 achados da auditoria, proteger os dados internos e tornar campanhas e chamadas confiáveis |

## 1. Contexto e limites da auditoria

O repositório contém serviços com mecanismos diferentes de autenticação, autorização e processamento de filas. Há proteções no CRM principal, como validação de sessão em APIs e assinatura do webhook Meta, mas elas não cobrem todos os caminhos identificados.

Este documento transforma os achados em requisitos de implementação e validação. Nenhuma correção de aplicação, migração ou alteração de infraestrutura foi executada durante a elaboração do PRD.

Limitações da evidência:

- A análise foi estática. Build, lint, testes automatizados e execução dos serviços não foram realizados: faltam dependências instaladas e Node/npm/Go disponíveis no ambiente analisado.
- Não houve acesso ao servidor, ao firewall, ao proxy, ao Supabase ou às variáveis de produção.
- A exposição real dos endpoints depende da topologia de implantação. As permissões efetivas do banco precisam ser consultadas, pois podem divergir dos scripts do repositório.
- Não há evidência de exploração ou incidente. Os riscos descritos decorrem dos caminhos identificados no código.
- Antes de implementar mudanças em Next.js, instalar as dependências e ler os guias relevantes em `node_modules/next/dist/docs/`, conforme `AGENTS.md`.

## 2. Objetivos e escopo

### Objetivos

1. Impedir operações sem autenticação ou sem autorização sobre a conta e o recurso.
2. Proteger dados pessoais, anexos e registros administrativos.
3. Corrigir duplicações, itens travados, confirmações de entrega e limites de campanhas.
4. Restringir a exposição de serviços auxiliares e tornar o ambiente reproduzível.
5. Cobrir todos os serviços ativos com verificações automatizadas relevantes.

### Fora do escopo

- Redesenho geral das telas, substituição do CRM ou migração de toda a arquitetura.
- Criação de funcionalidades comerciais novas.
- Certificação de segurança, pentest completo ou parecer jurídico.
- Alteração direta de produção durante a preparação deste documento.

### Serviços ativos

O primeiro passo de execução é confirmar quais serviços estão em uso. O disparador integrado ao Next.js e o disparador NestJS possuem processadores diferentes. Cada achado permanece aplicável ao código correspondente; se um módulo estiver descontinuado, seu encerramento deve incluir retirada dos endpoints, credenciais e artefatos de implantação, com evidência registrada.

## 3. Priorização e responsáveis sugeridos

- **P0 — Crítica:** corrigir ou conter antes de manter os caminhos afetados acessíveis a usuários não confiáveis.
- **P1 — Alta:** corrigir na primeira etapa após os P0; envolve dados internos, controle operacional ou confiabilidade de envio.
- **P2 — Média:** corrigir na etapa seguinte, sem perder as dependências com os itens de maior prioridade.

Os responsáveis abaixo representam funções, não pessoas já designadas.

| ID     | Problema                                       | Prioridade | Responsável sugerido                | Dependências                                   |
| ------ | ---------------------------------------------- | ---------- | ----------------------------------- | ---------------------------------------------- |
| CRM-01 | Webhook WAHA do CRM sem autenticação           | P0         | Backend + Integrações               | Configuração da instância WAHA                 |
| CRM-02 | API VoIP sem autenticação e isolamento         | P0         | Backend + VoIP + Infra              | Identidade dos usuários e vínculo sessão/conta |
| CRM-03 | RPCs privilegiadas sem autorização suficiente  | P0         | Banco de dados + Backend            | Inventário de funções e permissões reais       |
| CRM-04 | Credencial padrão e acesso global aos logs     | P1         | Backend + Segurança                 | Política de acesso administrativo              |
| CRM-05 | Anexos de conversas públicos                   | P1         | Backend + Frontend + Banco          | Fluxos de upload, leitura e entrega à Meta     |
| CRM-06 | Permissões insuficientes no NestJS             | P1         | Backend                             | Mapeamento de papéis e modelo de contas        |
| CRM-07 | Duplicação e travamento no worker NestJS       | P1         | Backend + Banco                     | Definição do consumidor de cada fila           |
| CRM-08 | Download de áudio VoIP sem restrições          | P1         | VoIP + Infra                        | CRM-02 para controle de acesso                 |
| CRM-09 | Endpoints NestJS abertos sem segredo           | P1         | Backend + Infra                     | Provisionamento de segredos e scheduler        |
| CRM-10 | Eventos de confirmação WAHA incompatíveis      | P2         | Integrações + Backend               | Contrato da versão WAHA implantada             |
| CRM-11 | Limite por hora e pausa entre lotes incorretos | P2         | Backend + Banco                     | Controle de concorrência das campanhas         |
| CRM-12 | Compose exposto e build incompleto             | P2         | Infra                               | Inventário dos serviços ativos                 |
| CRM-13 | Credencial administrativa em localStorage      | P2         | Frontend + Backend                  | Implementar em conjunto com CRM-04             |
| CRM-14 | CI cobre apenas o CRM principal                | P2         | Infra + Responsáveis pelos serviços | Runtimes e scripts de verificação              |

## 4. Requisitos de correção por achado

### CRM-01 — Autenticar o webhook WAHA do CRM

**Evidência:** [webhook WAHA](../src/app/api/whatsapp/webhook/waha/route.ts), função `POST`. A rota processa eventos com um cliente administrativo sem validar assinatura ou segredo. A conta é resolvida pelo nome da sessão enviado no corpo.

**Impacto:** um emissor que conheça uma sessão válida pode falsificar mensagens, confirmações e reações, modificar registros e acionar automações ou IA.

**Requisitos de implementação:**

- Verificar na documentação da versão WAHA implantada o mecanismo disponível de assinatura ou autenticação de webhooks. Preferir assinatura do corpo bruto; quando indisponível, usar um segredo exclusivo entregue em header pelo emissor.
- Vincular a credencial à integração/canal apropriado. O campo `session` não constitui prova de identidade.
- Validar autenticidade antes de qualquer mutação ou acionamento de fluxo/IA. Se a resolução do canal for necessária à validação, limitar essa leitura e não expor dados na resposta.
- Recusar requisições quando não existir uma credencial válida configurada. Não adicionar fallback que aceite eventos sem verificação.
- Configurar o emissor WAHA para enviar a assinatura/header e preservar a deduplicação por identificador de mensagem.
- Registrar rejeições sem armazenar segredo, token ou corpo completo da mensagem.

**Critérios de aceite:**

- [ ] Ausência de credencial, credencial incorreta e corpo adulterado quando assinado produzem rejeição, sem alterações no banco nem execução de IA/fluxos.
- [ ] Evento válido da integração configurada é processado normalmente.
- [ ] Credencial de um canal não autoriza um evento de outro canal.
- [ ] Reenvio do mesmo evento não duplica mensagem nem efeito operacional.

### CRM-02 — Proteger a API de chamadas e isolar sessões

**Evidência:** [rotas Go](../voip/cmd/server/httpapi.go), [rewrites Next.js](../next.config.ts) e [middleware](../src/middleware.ts). O Go expõe operações sem autenticação; o Next.js encaminha `/api/calls/*` e esse prefixo não recebe a validação de sessão no middleware.

**Impacto:** acesso não autorizado a sessões, histórico e eventos, criação de chamadas e desconexão de sessões. O risco existe via proxy do CRM mesmo que a porta Go não seja publicada diretamente.

**Requisitos de implementação:**

- Substituir o encaminhamento sem validação por uma fronteira autenticada para chamadas e SSE. Verificar uma identidade real; cookie apenas estruturalmente válido não basta.
- Implementar autenticação entre CRM e Go, com credencial de serviço ou token assinado de curta duração. Impedir que um cliente externo forje headers de identidade confiados pelo serviço.
- Persistir o vínculo entre sessão VoIP e conta; autorizar cada operação sobre esse vínculo.
- Filtrar listagens, histórico e eventos SSE pela conta autorizada. `X-Client-Id` deve continuar sendo identificador de cliente, nunca credencial de acesso.
- Reservar criação, exclusão, pareamento e logout de sessões a administradores; aplicar às chamadas a permissão operacional correspondente.
- Restringir a porta Go à rede interna e remover CORS `*` quando não houver necessidade. Se houver cliente direto, utilizar origens explícitas e autenticação equivalente.
- Adaptar o frontend e os clientes internos para a nova autenticação, incluindo a conexão SSE.

**Critérios de aceite:**

- [ ] Chamadas anônimas via domínio do CRM e diretamente ao serviço não executam operações.
- [ ] Usuário da conta A não lista, controla ou recebe eventos de sessões da conta B.
- [ ] Pareamento, chamadas e reconexão SSE continuam funcionando para usuários autorizados.
- [ ] Token de serviço inválido/expirado ou headers de identidade forjados são rejeitados.

### CRM-03 — Restringir funções privilegiadas do Supabase

**Evidência:** migrações [088](../supabase/migrations/088_messages_message_id_unique.sql), [091](../supabase/migrations/091_atomic_mark_sent.sql), [095](../supabase/migrations/095_increment_session_page_count.sql) e [112](../supabase/migrations/112_recalculate_campaign_metrics.sql). As funções usam `SECURITY DEFINER` e não validam a autorização sobre os IDs recebidos. A 088 concede execução a `authenticated`; as demais citadas não revogam execução pública nesses arquivos.

**Impacto:** se executáveis por clientes, podem alterar dados fora da conta do chamador ou adulterar fila e métricas. O alcance efetivo depende dos grants reais e dos schemas expostos pela API.

**Requisitos de implementação:**

- Inventariar funções `SECURITY DEFINER`, proprietário, grants, schemas expostos, chamadores e validações internas no banco de destino.
- Classificar cada função como interna ou destinada ao usuário. Funções internas devem ser executáveis somente pelos papéis necessários, normalmente `service_role`.
- Revogar explicitamente privilégios de `PUBLIC`, `anon` e `authenticated` quando não forem necessários; considerar privilégios previamente concedidos e padrões de criação de funções.
- Para funções destinadas ao usuário, verificar `auth.uid()`, conta, papel e propriedade do recurso dentro da função. Não confiar em `p_user_id` fornecido pelo cliente como prova de identidade.
- Em `mark_queue_item_sent`, verificar consistência entre item, campanha, contato e sessão e evitar que repetição da chamada crie logs ou contadores duplicados.
- Manter `search_path` restrito e referências de objetos qualificadas.
- Entregar migração nova e idempotente, sem depender apenas de editar migrações já aplicadas.

**Critérios de aceite:**

- [ ] Usuários anônimos não executam funções internas.
- [ ] Usuários autenticados não executam funções internas nem alteram recursos de outras contas por RPC.
- [ ] Chamadores internos autorizados continuam funcionando.
- [ ] Execução repetida do registro de envio não duplica log nem métrica.
- [ ] Permissões reais são conferidas após aplicar a migração em homologação e produção.

Referência técnica: [Database Functions — Supabase](https://supabase.com/docs/guides/database/functions).

### CRM-04 — Remover credenciais padrão e restringir logs

**Evidência:** [API de logs](../src/app/api/ddm-logs/route.ts). Há fallback de usuário/senha no código e consultas administrativas que atravessam contas.

**Impacto:** acesso a informações de usuários, sessões, ações e registros internos quando as variáveis não estão definidas ou a credencial compartilhada é conhecida.

**Requisitos de implementação:**

- Remover completamente o fallback de credencial. Como contenção inicial, acesso sem configuração deve ficar indisponível.
- Migrar para autenticação individual, compartilhando a implementação com CRM-13.
- Aplicar escopo por conta a todas as abas, filtros, contagens e detalhes, incluindo `users`, `sessions`, `actions`, `events`, `tests` e `feedback`.
- Definir acesso global de suporte como capacidade separada e explícita; ser administrador de uma conta não deve conceder acesso a todas as demais.
- Auditar acessos administrativos e omitir credenciais e conteúdo sensível desnecessário dos resultados.
- Aplicar limites de tentativas enquanto houver login administrativo separado.

**Critérios de aceite:**

- [ ] A credencial padrão antiga não autentica em nenhuma configuração.
- [ ] Ausência de configuração nunca libera consulta aos logs.
- [ ] Usuários sem permissão administrativa são rejeitados.
- [ ] Administrador de A não recebe dados de B em nenhuma aba ou filtro.
- [ ] Acesso global, caso necessário, exige capacidade explícita e gera auditoria atribuída a uma identidade.

### CRM-05 — Tornar privados os anexos de conversas

**Evidência:** [migração 023](../supabase/migrations/023_chat_media.sql) cria `chat-media` público e permite leitura sem escopo de conta. Os webhooks [Meta](../src/app/api/whatsapp/webhook/route.ts) e [WAHA](../src/app/api/whatsapp/webhook/waha/route.ts) usam `getPublicUrl`.

**Impacto:** links de documentos, imagens, vídeos e áudios podem permitir acesso sem sessão. A política de leitura também precisa ser validada quanto à listagem de objetos por usuários anônimos.

**Requisitos de implementação:**

- Inventariar uploads, armazenamento de URLs, previews, downloads, envios externos e mídias antigas.
- Tornar o bucket privado e substituir leitura pública por políticas de leitura/listagem vinculadas à conta e à permissão sobre a conversa.
- Armazenar caminho/identificador do objeto em vez de URL pública permanente. Fornecer URLs temporárias após autorização.
- Renovar links expirados no frontend sem perder o contexto da conversa.
- Preservar entregas à Meta/WAHA: preferir upload de mídia ao provedor quando suportado; alternativamente, usar URL temporária com duração suficiente e limitada.
- Migrar referências antigas sem excluir anexos. Validar invalidação das URLs públicas e caches envolvidos.
- Atualizar em conjunto backend, frontend e política de storage para evitar interromper envio e leitura de arquivos.

**Critérios de aceite:**

- [ ] URL pública antiga e listagem anônima não permitem acesso aos objetos do bucket.
- [ ] Conta A não lista nem gera link para anexos de B.
- [ ] Links temporários expiram e não são gerados sem autorização.
- [ ] Anexos antigos e novos abrem no CRM e continuam sendo entregues aos provedores.
- [ ] Expiração durante uma sessão é tratada pelo frontend com renovação autorizada.

### CRM-06 — Aplicar autorização e validação no NestJS

**Evidência:** [controller](../disparador/backend/src/campaigns/campaigns.controller.ts), [service de campanhas](../disparador/backend/src/campaigns/campaigns.service.ts) e [cliente Supabase](../disparador/backend/src/common/supabase/supabase.service.ts). O JWT é verificado, mas não há escopo por conta e o service utiliza `service_role`. A atualização recebe o corpo inteiro.

**Impacto:** usuário autenticado pode executar operações incompatíveis com seu papel e, em uma implantação com múltiplas contas, acessar campanhas de outra conta. Campos internos também podem ser alterados pelo corpo da requisição.

**Requisitos de implementação:**

- Mapear o papel `operador` do NestJS para as capacidades do CRM. Validar o modelo de tabelas/schema usado pelo serviço, sem presumir que seja idêntico ao Next.js.
- Estabelecer uma matriz única de capacidades. Proposta inicial: leitura para usuários autorizados da conta; criação/edição operacional para agentes; aprovação e exclusão para administradores/proprietários.
- Resolver conta e permissões a partir da identidade validada e dos registros confiáveis; não aceitar `account_id`, papel ou proprietário do corpo como autorização.
- Aplicar escopo e propriedade em leitura, alteração, aprovação, início, pausa, encerramento, duplicação e vínculo de contatos/sessões.
- Substituir `any` por DTOs e validar campos, tipos, limites e estados permitidos. Impedir alteração livre de `created_by`, `approved_by`, `account_id` e campos internos.
- Validar transições de status no backend; o cliente não deve contornar aprovação alterando `status` diretamente.
- Revisar os demais controllers que compartilham esse cliente administrativo para aplicar o mesmo padrão.

**Critérios de aceite:**

- [ ] Operador/agente não aprova ou exclui campanha sem a capacidade prevista.
- [ ] Acesso por ID de outra conta é rejeitado em todas as operações.
- [ ] Campos internos enviados pelo cliente são rejeitados ou ignorados sem mudança de autorização.
- [ ] DTOs inválidos retornam erro de validação e não provocam escrita parcial.
- [ ] Operações autorizadas continuam funcionando com os papéis oficialmente mapeados.

### CRM-07 — Corrigir concorrência e adiamento no worker NestJS

**Evidência:** [worker](../disparador/backend/src/message-queue/message-queue.worker.ts), função `processNext`. A seleção e a mudança para `enviando` são separadas, sem condição atômica de disputa. Fora da janela, apenas o horário é alterado e o item permanece `enviando`.

**Impacto:** múltiplas instâncias podem enviar o mesmo item; itens adiados podem deixar de ser consumidos. Se dois serviços usarem a mesma fila, seus protocolos precisam ser compatíveis.

**Requisitos de implementação:**

- Definir qual processador é responsável por cada fila. Se Next.js e NestJS operarem na mesma tabela, usar o mesmo protocolo de reivindicação ou separar explicitamente os consumidores.
- Reivindicar itens em operação atômica no banco, com estado anterior verificado e resultado indicando o vencedor. Utilizar lease/identificador de execução para escritas posteriores.
- Ao adiar por janela, retornar para `agendado` e calcular a próxima abertura válida, considerando horário anterior à abertura, posterior ao fechamento e janelas que atravessam meia-noite.
- Definir o fuso horário operacional explicitamente, sem depender do fuso do host.
- Recuperar leases expiradas com verificação da situação do envio. Não reenviar automaticamente uma entrega já confirmada pelo provedor.
- Usar idempotência ou reconciliação com o provedor nos casos de timeout após envio. Reivindicação atômica, isoladamente, não garante envio exatamente uma vez em falhas externas.
- Registrar tentativas, adiamentos e recuperação sem bloquear permanentemente a fila.

**Critérios de aceite:**

- [ ] Dois workers concorrentes disputando o mesmo item resultam em uma única reivindicação e um único envio no cenário testado.
- [ ] Item fora da janela volta a `agendado` e é consumido na próxima abertura correta.
- [ ] Queda antes do envio permite recuperação sem travamento permanente.
- [ ] Queda/timeout depois da aceitação externa segue a estratégia de reconciliação, sem reenvio cego.
- [ ] Alterar o fuso do servidor não modifica a janela definida para a campanha.

### CRM-08 — Restringir downloads de áudio no VoIP

**Evidência:** [API Go](../voip/cmd/server/httpapi.go), função `doPlayAudio`. O serviço faz `http.Get` na URL recebida e `io.ReadAll` sem limite de tamanho ou timeout explícito.

**Impacto:** requisições a recursos da rede interna e consumo excessivo de memória, conexões ou goroutines.

**Requisitos de implementação:**

- Preferir receber uma referência de mídia autorizada e resolvê-la internamente. Se URLs forem necessárias, restringir protocolos, destinos e portas conforme a integração.
- Bloquear loopback, redes privadas, link-local, endereços de metadados e equivalentes IPv6, inclusive endereços IPv4 mapeados em IPv6.
- Validar resolução DNS e destino efetivo da conexão para evitar troca de IP entre validação e download.
- Desabilitar redirecionamentos ou revalidar cada destino com a mesma política.
- Configurar timeout, cancelamento por contexto, limite de bytes e limite de downloads simultâneos. A política deve bloquear respostas grandes mesmo sem `Content-Length`.
- Verificar código HTTP e formatos suportados antes de decodificar/reproduzir.
- Cancelar downloads quando a chamada terminar e evitar registrar URLs contendo tokens de acesso.

**Critérios de aceite:**

- [ ] Destinos internos, redirecionamento para endereço interno e cenários de DNS mutável são bloqueados.
- [ ] Resposta acima do limite ou servidor lento encerra o download e libera recursos.
- [ ] Requisições concorrentes obedecem ao limite configurado.
- [ ] Áudio válido de origem autorizada continua funcionando.

### CRM-09 — Recusar endpoints operacionais sem segredo

**Evidência:** [webhook NestJS](../disparador/backend/src/webhooks/webhooks.controller.ts) e [process-tick](../disparador/backend/src/message-queue/message-queue.controller.ts). A condição `expected && secret !== expected` libera execução quando a variável está ausente.

**Impacto:** processamento de eventos e acionamento de fila sem autenticação em ambientes incompletamente configurados.

**Requisitos de implementação:**

- Exigir segredo não vazio para funcionalidades habilitadas; se ausente, falhar na inicialização ou retornar indisponibilidade sem executar a operação.
- Comparar segredos de maneira resistente a diferenças de tempo, sem registrá-los.
- Separar credenciais de webhook e scheduler; provisionar valores exclusivos por ambiente.
- Atualizar exemplos de ambiente, implantação e instruções do scheduler, incluindo o `CRON_SECRET` necessário ao endpoint correspondente.
- Documentar rotação coordenada e restringir acesso de rede quando aplicável.

**Critérios de aceite:**

- [ ] Com variável ausente/vazia, o serviço ou endpoint falha de forma explícita e não processa nada.
- [ ] Header ausente ou incorreto é rejeitado.
- [ ] Credencial correta executa a operação prevista.
- [ ] Segredo do scheduler não autentica o webhook e vice-versa.

### CRM-10 — Corrigir confirmações de entrega e leitura WAHA

**Evidência:** [configuração WAHA](../src/lib/whatsapp/waha-api.ts), função `startWahaSession`, assina `message.ack`; o [webhook](../src/app/api/whatsapp/webhook/waha/route.ts) trata `message.status`.

**Impacto:** eventos configurados são ignorados e o CRM pode apresentar estados de envio, entrega e leitura desatualizados.

**Requisitos de implementação:**

- Confirmar na versão WAHA implantada o nome do evento, campos do payload e valores de confirmação.
- Alinhar assinatura do emissor e parser do receptor. Não presumir que basta renomear o evento sem adaptar o payload.
- Mapear confirmações para `sent`, `delivered` e `read`, sem regredir de `read` para `delivered` por evento atrasado.
- Vincular a mensagem ao canal/conta autenticado antes da atualização administrativa.
- Reconfigurar sessões existentes usando o procedimento menos disruptivo suportado; documentar se alguma reconexão é necessária.

**Critérios de aceite:**

- [ ] Payloads reais sanitizados da versão implantada atualizam envio, entrega e leitura.
- [ ] Eventos duplicados ou fora de ordem não duplicam efeitos nem regridem estado.
- [ ] Evento de um canal não altera mensagem de outro.
- [ ] A atualização das sessões existentes preserva a integração ou tem janela de reconexão documentada.

### CRM-11 — Respeitar limite horário e pausa entre lotes

**Evidência:** [cron do disparador](../src/app/api/disparador/cron/route.ts). A quantidade já enviada é comparada com o limite, mas a busca usa `batch_size` inteiro. Revisão complementar: `batch_pause_seconds` é aplicado ao `scheduled_at` no enfileiramento em [startCampaign](../src/lib/disparador/startCampaign.ts); o cron não mantém uma pausa baseada na execução real. Quando itens atrasados se acumulam ou ticks extras ocorrem, o agendamento inicial não impede aceleração dos lotes elegíveis. Ver [PRD 03 — Crons, duplicação e sobrecarga](./PRD-crons-duplicacao-sobrecarga-crm.md).

**Impacto:** ultrapassagem do limite configurado e cadência diferente da escolhida pelo operador. Por exemplo, 99 envios com limite 100 e lote 20 permitem selecionar mais 20 itens.

**Requisitos de implementação:**

- Definir a semântica da quota: proposta de janela móvel de 60 minutos, considerando reservas em andamento para impedir excesso sob concorrência.
- Limitar novos itens ao menor valor entre tamanho do lote e capacidade restante.
- Reservar quota e liberar/reconciliar reservas de forma atômica. Apenas consultar o contador antes do lote não é suficiente com crons concorrentes.
- Persistir `next_batch_at` ou controle equivalente e aplicar `batch_pause_seconds` mesmo com invocações frequentes do cron.
- Evitar espera longa dentro da resposta HTTP; selecionar campanhas elegíveis pelo horário persistido.
- Encerrar campanha somente quando não houver itens agendados, em envio ou elegíveis a retry; validar essa condição sob sobreposição de invocações.
- Exibir na interface o motivo de espera por quota ou pausa e o próximo horário estimado.

**Critérios de aceite:**

- [ ] Com 99 envios, limite 100 e lote 20, há no máximo uma nova reserva/envio elegível.
- [ ] Duas invocações concorrentes não ultrapassam a capacidade disponível.
- [ ] Pausa de 180 segundos não permite um novo lote após apenas 60 segundos.
- [ ] Quota se recompõe ao fim da janela e reservas abandonadas têm recuperação definida.
- [ ] Campanha com envio em andamento não é encerrada prematuramente.

### CRM-12 — Corrigir e restringir o ambiente Docker

**Evidência:** [Compose](../disparador/docker-compose.yml). Redis publica 6379 e o painel de filas publica 3002 sem autenticação configurada nesse arquivo. O frontend tem `build: ./frontend`, mas não possui Dockerfile no diretório analisado.

**Impacto:** exposição de serviços auxiliares se o host/firewall permitir; falha no build completo do Compose. O arquivo define `NODE_ENV=development`, portanto sua adequação à produção não pode ser presumida.

**Requisitos de implementação:**

- Separar configuração de desenvolvimento e produção, com documentação de uso.
- Remover publicação pública de Redis em produção e utilizar rede privada. Para acesso local necessário, vincular a loopback e aplicar autenticação/ACL apropriada.
- Retirar o painel de filas de produção ou protegê-lo com autenticação e acesso administrativo restrito.
- Fornecer Dockerfile do frontend compatível com sua própria versão Next.js, ou remover esse build se o módulo não for utilizado.
- Garantir que endpoints operacionais e interface administrativa respeitem CRM-09 e CRM-06.
- Configurar persistência dos serviços que a exigem, healthchecks, reinício e variáveis obrigatórias; não pressupor que um volume sozinho garante a política de durabilidade do Redis.
- Usar instalação baseada no lockfile e versões de imagem explícitas para o ambiente de produção.

**Critérios de aceite:**

- [ ] `docker compose config` e build dos serviços ativos concluem em ambiente limpo.
- [ ] Redis e painel de filas não são acessíveis pela interface pública da implantação de produção.
- [ ] Frontend se comunica com o backend pela URL correta do ambiente.
- [ ] Reinício preserva os dados previstos pela política de persistência.
- [ ] Configuração de produção não monta o código-fonte como volume de desenvolvimento.

### CRM-13 — Remover a credencial administrativa do localStorage

**Evidência:** [página de logs](../src/app/ddm-logs/page.tsx), funções `encodeBasicAuth` e `handleLoginSubmit`. O header Basic Auth é armazenado no navegador; Base64 não protege a senha contra leitura.

**Impacto:** JavaScript executado na origem pode extrair uma credencial administrativa reutilizável. A credencial compartilhada também dificulta identificar o operador responsável por um acesso.

**Requisitos de implementação:**

- Implementar em conjunto com CRM-04 uma identidade individual para acesso administrativo.
- Se usar sessão administrativa própria, entregá-la por cookie `HttpOnly`, `Secure` em produção, com `SameSite` adequado, expiração e revogação no servidor.
- Se reutilizar a sessão existente do CRM, exigir autorização administrativa no servidor e não criar outra credencial privilegiada persistente no frontend. Não declarar cookies atuais como `HttpOnly` sem adaptar fluxos que dependem de acesso pelo SDK no navegador.
- Remover leitura/escrita do Basic Auth em `localStorage` e limpar a chave legada na atualização.
- Não transferir a senha para `sessionStorage`, query string ou logs.
- Disponibilizar logout e revogação; proteger operações mutáveis contra CSRF caso a autenticação passe a usar cookies.

**Critérios de aceite:**

- [ ] Após login administrativo, storage do navegador não contém senha ou header Basic Auth.
- [ ] A chave antiga é removida e a credencial antiga deixa de ser aceita no backend.
- [ ] Sessão expirada, revogada ou sem capacidade administrativa não acessa os logs.
- [ ] Logout invalida o acesso e identidades distintas aparecem na auditoria.
- [ ] Caso criada, a sessão administrativa em cookie possui os atributos previstos.

### CRM-14 — Ampliar o CI aos serviços ativos

**Evidência:** [workflow CI](../.github/workflows/ci.yml) executa scripts na raiz; o [tsconfig principal](../tsconfig.json) exclui `disparador` e `voip`.

**Impacto:** falhas dos módulos auxiliares podem chegar à implantação mesmo com o CI do CRM principal aprovado.

**Requisitos de implementação:**

- Criar jobs independentes para CRM principal, backend NestJS, frontend do disparador e backend/cliente VoIP, conforme inventário de módulos ativos.
- No CRM, manter lint, typecheck, testes e build. No NestJS e frontends auxiliares, fornecer scripts e configurações verificáveis de lint/typecheck/build e testes relevantes.
- No Go, executar compilação, `go vet` e testes aplicáveis; usar detecção de corrida nos cenários concorrentes quando suportada pelo ambiente de CI.
- Executar `npm ci` em cada pacote com lockfile, configurar versões de runtime compatíveis e cache separado.
- Adicionar validação de migrações em banco descartável, com testes de permissões/RLS/RPC dos caminhos corrigidos, e smoke de build dos containers ativos.
- Priorizar testes dos contratos de autenticação, isolamento entre contas, disputa de fila, limites de campanha e eventos WAHA. Evitar testes que apenas repetem a implementação.
- Usar mocks, fixtures sanitizadas e ambiente descartável; os jobs não devem enviar WhatsApp real, fazer chamadas reais ou depender de credenciais de produção.
- Configurar os checks necessários como obrigatórios no fluxo de integração do repositório real.

**Critérios de aceite:**

- [ ] Erro de compilação em qualquer serviço ativo reprova o pipeline correspondente.
- [ ] Regressões de autenticação, autorização e concorrência são detectadas pelos testes.
- [ ] Migrações e imagens dos serviços ativos são validadas em ambiente limpo.
- [ ] CI não exige nem publica segredos reais.
- [ ] Todos os checks definidos executam e aprovam antes da implantação.

## 5. Plano de execução

| Etapa                         | Entregas                                                                                                                 | Condição para avançar                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 0 — Preparação                | Inventário de serviços ativos, runtimes, schemas, permissões e integrações; ambiente de homologação com dados sintéticos | Topologia e fluxos afetados documentados; build/testes de referência executados ou falhas registradas |
| 1 — Contenção e P0            | CRM-01, CRM-02 e CRM-03; remover fallback dos logs e bloquear endpoints sem segredo                                      | Acesso anônimo e entre contas rejeitado nos caminhos críticos; integrações autorizadas operacionais   |
| 2 — Dados e confiabilidade    | CRM-04/13 em conjunto, CRM-05, CRM-06, CRM-07, CRM-08 e CRM-09                                                           | Critérios de aceite P1 aprovados, migrações verificadas e dados preservados                           |
| 3 — Operação e infraestrutura | CRM-10, CRM-11 e CRM-12                                                                                                  | Confirmações, quotas, pausas e implantação testadas                                                   |
| 4 — Consolidação              | CRM-14, regressão integrada, runbooks e acompanhamento                                                                   | Checks obrigatórios aprovados e evidências de homologação registradas                                 |

Os testes e checks de CRM-14 devem ser adicionados junto às correções sempre que possível; a etapa 4 consolida a cobertura. Não é necessário esperar a conclusão das demais etapas para começar o CI.

Não há prazo fechado neste PRD: estimativas dependem do inventário, das versões implantadas e do ambiente de homologação.

## 6. Validação integrada

Preparar pelo menos duas contas independentes, com usuários administrativos e operacionais, canais e sessões separados. Usar serviços externos simulados e arquivos sem dados pessoais.

| Cenário                                               | Resultado esperado                                                        | Achados cobertos       |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------- |
| Requisição anônima ou com credencial inválida         | Rejeição sem mutação nem efeitos externos                                 | 01, 02, 04, 09         |
| Usuário A envia ID de recurso B                       | Rejeição sem vazamento nem alteração                                      | 02, 03, 04, 05, 06, 10 |
| RPC interna chamada pelo navegador                    | Permissão negada                                                          | 03                     |
| Webhook repetido ou fora de ordem                     | Estado consistente e efeitos deduplicados                                 | 01, 10                 |
| Dois workers/crons simultâneos                        | Disputa controlada, quota respeitada e ausência de encerramento prematuro | 07, 11                 |
| Item fora da janela ou lease expirada                 | Reagendamento correto e recuperação conforme estado externo               | 07                     |
| URL interna, download lento ou muito grande           | Bloqueio/cancelamento e recursos liberados                                | 08                     |
| Anexo antigo, link expirado e envio à Meta/WAHA       | Leitura autorizada e integração preservada                                | 05                     |
| Login/logout administrativo e atualização do frontend | Credencial legada removida e sessão revogada corretamente                 | 04, 13                 |
| Build limpo de cada serviço e containers              | Pipeline detecta falhas e publica resultado verificável                   | 12, 14                 |

## 7. Implantação, migrações e recuperação

- Registrar a versão dos serviços, as migrações aplicadas e os grants antes da mudança. Preparar backup e validar recuperação antes de migrações de dados.
- Provisionar segredos e configurar emissores/schedulers antes de ativar a exigência correspondente. Evitar uma janela que aceite requisições sem credencial.
- Coordenar a fronteira CRM/Go e a adaptação dos clientes para não interromper chamadas válidas.
- Aplicar novas migrações e validar permissões reais. Não tratar edição de arquivo SQL antigo como atualização automática do banco existente.
- Para fila, interromper ou coordenar consumidores durante alterações incompatíveis de estado/lease; identificar envios em andamento antes de retomá-los.
- Para mídia, adaptar leitores e remetentes antes de fechar o bucket, migrar referências e só então validar a retirada das URLs públicas.
- Para rollback, preservar fechamento de acesso e privacidade: restaurar a aplicação para uma versão compatível ou desabilitar temporariamente a funcionalidade afetada. Não reintroduzir senha padrão, webhook aberto ou bucket público como recuperação automática.
- Após implantação, acompanhar rejeições de autenticação, falhas de integração, itens presos, duplicações, quota, atraso de fila e erros de leitura de mídia.

## 8. Decisões a registrar antes das implementações dependentes

| Decisão                             | Proposta inicial / ação necessária                                                                          | Itens afetados |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| Quais serviços estão ativos?        | Inventariar Next.js integrado, NestJS, frontend auxiliar e VoIP; retirar formalmente módulos descontinuados | Todos          |
| Qual é a topologia de acesso?       | Documentar proxy, portas publicadas, firewall e origens dos clientes                                        | 02, 08, 12     |
| Qual é o contrato WAHA?             | Confirmar versão, autenticação de webhook, eventos e payloads com evidência sanitizada                      | 01, 10         |
| Quem administra os logs?            | Admin/owner acessa somente sua conta; suporte global exige capacidade separada                              | 04, 13         |
| Como mapear papéis NestJS/CRM?      | Registrar equivalência de `operador` e capacidades, incluindo aprovação e exclusão                          | 06             |
| Quem consome cada fila?             | Preferir um consumidor definido por fila; se compartilhada, protocolo atômico comum                         | 07, 11         |
| Qual é a semântica do limite?       | Janela móvel de 60 minutos com reservas concorrentes contabilizadas                                         | 11             |
| Qual é o fuso das campanhas?        | Configuração explícita, alinhada à operação; não depender do host                                           | 07             |
| Como entregar mídia aos provedores? | Upload ao provedor quando suportado; caso contrário, URL temporária autorizada                              | 05             |
| Quais funções SQL são internas?     | Inventário de chamadores e privilégios efetivos antes da migração                                           | 03             |

Essas decisões não impedem contenções independentes, como remover a senha padrão, rejeitar segredo ausente e restringir portas auxiliares.

## 9. Definição de conclusão

O trabalho estará concluído quando:

- [ ] Cada um dos 14 itens tiver correção implementada e evidência de validação, ou retirada formal do módulo afetado com comprovação de que não permanece exposto.
- [ ] Os critérios de aceite aplicáveis estiverem aprovados em homologação.
- [ ] Build, lint, typecheck e testes relevantes dos serviços ativos estiverem executados, com resultados registrados.
- [ ] Migrações, permissões, segredos e configurações de rede tiverem sido conferidos no ambiente de destino.
- [ ] Os fluxos de atendimento, envio, chamadas, anexos, confirmação e campanhas permanecerem operacionais.
- [ ] Runbooks de configuração, rotação de segredos, recuperação da fila e implantação estiverem atualizados.
- [ ] Cada entrega registrar arquivos alterados, testes executados, limitações remanescentes e procedimento de implantação/recuperação.

## 10. Controle de execução

Todos os itens começam como **não iniciados**. Usar os IDs deste documento em tarefas e PRs para manter rastreabilidade.

| ID     | Status inicial | Evidência necessária para encerramento                              |
| ------ | -------------- | ------------------------------------------------------------------- |
| CRM-01 | Não iniciado   | Testes de autenticação, integridade e deduplicação do webhook       |
| CRM-02 | Não iniciado   | Testes via proxy, acesso direto, isolamento e SSE                   |
| CRM-03 | Não iniciado   | Migração, inventário de grants e testes de RPC por papel/conta      |
| CRM-04 | Não iniciado   | Testes de logs por identidade, capacidade e conta                   |
| CRM-05 | Não iniciado   | Validação de storage privado, referências antigas e entrega externa |
| CRM-06 | Não iniciado   | Matriz de permissões, DTOs e testes por operação                    |
| CRM-07 | Não iniciado   | Testes concorrentes, adiamento e recuperação de falha               |
| CRM-08 | Não iniciado   | Testes de destinos bloqueados, redirects, DNS e limites             |
| CRM-09 | Não iniciado   | Testes com segredo ausente, inválido e correto                      |
| CRM-10 | Não iniciado   | Fixtures do contrato WAHA e validação de estados                    |
| CRM-11 | Não iniciado   | Testes de quota, pausa e sobreposição de crons                      |
| CRM-12 | Não iniciado   | Build limpo, verificação de portas e persistência                   |
| CRM-13 | Não iniciado   | Inspeção de storage/cookies e testes de expiração/logout            |
| CRM-14 | Não iniciado   | Pipeline de todos os serviços ativos com checks aprovados           |
