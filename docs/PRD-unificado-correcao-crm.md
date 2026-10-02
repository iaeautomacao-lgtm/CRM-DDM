# PRD unificado — Correções do CRM interno

| Campo      | Valor                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Data       | 01/10/2026                                                                                                                       |
| Versão     | 1.0 — Consolidação dos três PRDs                                                                                                 |
| Status     | Primeira entrega implementada na branch fix/crm-reliability-security; validação e implantação pendentes conforme registro abaixo |
| Escopo     | Segurança, infraestrutura, backend, frontend, login, usabilidade, filas, crons, WhatsApp/Meta, WAHA, IA e VoIP                   |
| Origem     | Revisão estática do código e configurações; relato de duplicação WhatsApp/Meta e sobrecarga                                      |
| Inventário | 34 registros de achados/requisitos e 1 decisão de produto; há sobreposições explicitadas abaixo                                  |
| Uso        | Documento principal para criar tarefas, implementar, revisar e registrar validação                                               |

Este documento substitui os três PRDs anteriores como referência de execução. Os IDs CRM-01 a CRM-14, UX-01 a UX-08, CRON-01 a CRON-12 e DEC-01 foram preservados. Os arquivos anteriores permanecem como histórico; a evolução do backlog e das evidências deve ser registrada aqui.

## 1. Objetivo, escopo e limites

Proteger dados e operações por conta, tornar os envios e campanhas confiáveis, controlar a carga das integrações, recuperar acesso sem ciclos e preservar o trabalho do usuário. A implementação cobre os serviços que forem confirmados como ativos: CRM Next.js/Supabase, disparador integrado, disparador NestJS e seu frontend, e VoIP em Go.

A análise foi estática. Não foram executados build, lint, testes, migrações, mensagens reais ou alterações de produção. Faltam runtimes e dependências no ambiente analisado; não houve acesso às permissões efetivas do banco, servidores, agendadores e métricas. Comportamentos visuais e cenários de concorrência precisam ser reproduzidos em homologação. A duplicação foi relatada pelo usuário, mas a causa do incidente ainda depende de correlação com logs e IDs Meta. Os achados não constituem comprovação de exploração nem garantia de envio exatamente uma vez.

Antes de escrever código Next.js, instalar as dependências e ler os guias relevantes em `node_modules/next/dist/docs/`, conforme `AGENTS.md`. Validar as versões e contratos efetivamente implantados dos provedores e de cada serviço.

Não fazem parte deste trabalho um redesenho completo, funcionalidades comerciais novas, troca do CRM ou provedor de autenticação, certificação de segurança ou declaração integral de conformidade de acessibilidade. A política de cadastro depende de DEC-01. Se um serviço estiver descontinuado, encerrar seus itens exige evidência da retirada de endpoints, credenciais e implantação.

### Navegação

- [Backlog único e prioridades](#backlog)
- [Ordem de execução e dependências](#plano-execucao)
- [Segurança, backend e infraestrutura — CRM](#seguranca-infraestrutura)
- [Login, interface e usabilidade — UX e DEC-01](#login-interface)
- [Crons, duplicação e integrações — CRON](#crons-integracoes)
- [Diagnóstico em produção](#diagnostico-producao)
- [Validação, implantação e observabilidade](#validacao)
- [Decisões técnicas e definição de conclusão](#conclusao)

<a id="backlog"></a>

## 2. Backlog único e prioridades

**P0:** conter riscos críticos de acesso ou reenvio de operações aceitas. **P1:** corrigir confiabilidade, proteção de dados, acesso e perda de trabalho na sequência. **P2:** melhorar operação, implantação, navegação e acessibilidade. DEC-01 permanece como decisão pendente.

CRM-07 passa a P0 para acompanhar a competição de consumidores detalhada em CRON-04; CRM-11 passa a P1 para acompanhar os controles de carga de CRON-09/10. A prioridade não comprova que o serviço esteja ativo em produção: confirmar essa condição na etapa 0.

Os responsáveis são funções sugeridas, ainda sem pessoas designadas. Os estados abaixo são iniciais; atualizar cada linha com responsável, tarefa/PR e evidência conforme a execução avançar.

| ID                  | Tema                                                              | Prioridade       | Responsável sugerido                    | Status               | Tarefa/PR e evidência                             |
| ------------------- | ----------------------------------------------------------------- | ---------------- | --------------------------------------- | -------------------- | ------------------------------------------------- |
| [CRM-01](#crm-01)   | Webhook WAHA do CRM sem autenticação                              | P0               | Backend + Integrações                   | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRM-02](#crm-02)   | API VoIP sem autenticação e isolamento                            | P0               | Backend + VoIP + Infra                  | Não iniciado         | A registrar                                       |
| [CRM-03](#crm-03)   | RPCs privilegiadas sem autorização suficiente                     | P0               | Banco de dados + Backend                | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRM-04](#crm-04)   | Credencial padrão e acesso global aos logs                        | P1               | Backend + Segurança                     | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRM-05](#crm-05)   | Anexos de conversas públicos                                      | P1               | Backend + Frontend + Banco              | Não iniciado         | A registrar                                       |
| [CRM-06](#crm-06)   | Permissões insuficientes no NestJS                                | P1               | Backend                                 | Não iniciado         | A registrar                                       |
| [CRM-07](#crm-07)   | Duplicação e travamento no worker NestJS                          | P0               | Backend + Banco                         | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRM-08](#crm-08)   | Download de áudio VoIP sem restrições                             | P1               | VoIP + Infra                            | Não iniciado         | A registrar                                       |
| [CRM-09](#crm-09)   | Endpoints NestJS abertos sem segredo                              | P1               | Backend + Infra                         | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRM-10](#crm-10)   | Eventos de confirmação WAHA incompatíveis                         | P2               | Integrações + Backend                   | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRM-11](#crm-11)   | Limite por hora e pausa entre lotes incorretos                    | P1               | Backend + Banco                         | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRM-12](#crm-12)   | Compose exposto e build incompleto                                | P2               | Infra                                   | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRM-13](#crm-13)   | Credencial administrativa em localStorage                         | P2               | Frontend + Backend                      | Não iniciado         | A registrar                                       |
| [CRM-14](#crm-14)   | CI cobre apenas o CRM principal                                   | P2               | Infra + Responsáveis pelos serviços     | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [UX-01](#ux-01)     | Ciclos de login e tratamento de 401                               | P1               | Frontend + Backend                      | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [UX-02](#ux-02)     | Falha de perfil apresentada como falta de permissão               | P1               | Frontend + Backend                      | Não iniciado         | A registrar                                       |
| [UX-03](#ux-03)     | Recuperação de senha e erros de callback                          | P1               | Frontend + Autenticação                 | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [UX-04](#ux-04)     | Menu incompatível com perfil e acesso à própria senha             | P2               | Frontend + Produto                      | Não iniciado         | A registrar                                       |
| [UX-05](#ux-05)     | Retorno ao destino original após login                            | P2               | Frontend + Autenticação                 | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [UX-06](#ux-06)     | Preservação de alterações no editor de fluxos                     | P1               | Frontend + Backend                      | Não iniciado         | A registrar                                       |
| [UX-07](#ux-07)     | Navegação móvel do disparador                                     | P2               | Frontend                                | Não iniciado         | A registrar                                       |
| [UX-08](#ux-08)     | Acessibilidade e textos de interface                              | P2               | Frontend + Produto                      | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [DEC-01](#dec-01)   | Cadastro aberto ou somente por convite                            | Decisão pendente | Responsável pelo produto + Autenticação | Decisão pendente     | A registrar                                       |
| [CRON-01](#cron-01) | Health check aciona crons reais                                   | P1               | Backend + Infra                         | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-02](#cron-02) | Itens em envio são recolocados na fila por idade                  | P0               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-03](#cron-03) | Meta aceita envio, mas erro local é devolvido como falha          | P0               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-04](#cron-04) | Worker NestJS não reivindica atomicamente                         | P0               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-05](#cron-05) | Campanha fica executável antes de terminar o enfileiramento       | P0               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-06](#cron-06) | Finalização e callback não possuem vencedor único                 | P1               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-07](#cron-07) | Falhas Meta assíncronas e eventos atrasados podem reabrir retries | P1               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-08](#cron-08) | Registro de sucesso possui fallback com erros não conferidos      | P0               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-09](#cron-09) | Lotes usam paralelismo e quota somente por campanha               | P1               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-10](#cron-10) | Pausa inicial não limita lotes atrasados na execução real         | P1               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |
| [CRON-11](#cron-11) | Debounce da IA global não identifica o dono da resposta           | P1               | Backend + IA + Banco                    | Não iniciado         | A registrar                                       |
| [CRON-12](#cron-12) | Chamadas externas e retomadas carecem de controle comum de carga  | P1               | Backend + Banco + Integrações           | Em validação parcial | [Entrega 01](./PR-01-correcao-crons-seguranca.md) |

### Sobreposições: implementar uma vez e validar todos os critérios

| Entrega compartilhada                 | IDs relacionados                            | Tratamento                                                                                                                |
| ------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Consumidor NestJS e protocolo da fila | CRM-07 + CRON-04; recuperação em CRON-02/08 | Uma entrega coordenada para claim, dono/lease e recuperação. Preservar também os requisitos de adiamento e fuso de CRM-07 |
| Quota e cadência real                 | CRM-11 + CRON-09 + CRON-10                  | Um controle compartilhado por canal, com reservas concorrentes, limite de paralelismo e pausa aplicada na execução        |
| Acesso administrativo aos logs        | CRM-04 + CRM-13; interface em UX-08         | Alterar backend e sessão do frontend juntos, removendo credenciais legadas                                                |
| Autorização e navegação               | CRM-06 + UX-02/04                           | Alinhar capacidades entre API e interface, respeitando os fluxos distintos de cada serviço                                |
| CI e regressão                        | CRM-14 + todos os itens                     | Acrescentar verificações relevantes durante cada correção; consolidar cobertura dos serviços ativos                       |

Essas relações não eliminam os IDs nem seus critérios de aceite. Uma única tarefa ou PR pode resolver vários IDs, mas só fechar cada registro quando todos os critérios correspondentes tiverem evidência. Não somar os 34 registros como se fossem 34 causas independentes.

<a id="plano-execucao"></a>

## 3. Ordem de execução e dependências

| Etapa                                     | Entregas                                                                                                                                                                                                       | Condição para avançar                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — Preparação e diagnóstico              | Inventariar serviços, instâncias, contas/schemas, agendadores, migrações, grants e provedores. Preparar homologação, dados sintéticos e ferramentas. Correlacionar o incidente conforme a seção de diagnóstico | Topologia e donos das filas registrados; cenários reproduzíveis; limitações e estados externos conhecidos ou explicitamente classificados como desconhecidos |
| 1 — Contenção crítica                     | CRM-01/02/03; CRM-07 + CRON-04 se ativos; eliminar acionamentos redundantes e separar diagnóstico de execução em CRON-01. Remover fallback de credenciais CRM-04 e exigir segredo CRM-09                       | Acesso indevido bloqueado; consumidor definido por fila; health check sem efeitos operacionais; integrações autorizadas preservadas                          |
| 2 — Segurança do envio e estados          | CRON-02/03/05/06/07/08: operação persistente, resultado ambíguo, preparação de campanha, confirmação idempotente e conclusão/callback. Incluir requisitos de recuperação/adiamento de CRM-07                   | Aceitação externa preservada sob falha local; nenhum retry cego; testes de concorrência, webhook e conclusão aprovados                                       |
| 3 — Proteção de dados e controle de carga | CRM-04/13 juntos, CRM-05/06/08/09; CRM-11 + CRON-09/10; CRON-11/12. Coordenar permissões necessárias antes das telas dependentes                                                                               | Isolamento por conta validado; dados privados; cadência e limites agregados respeitados; IA e integrações protegidas contra efeitos repetidos                |
| 4 — Acesso e preservação do trabalho      | UX-01/02/03/06, em paralelo às etapas 2 e 3 quando não dependerem delas                                                                                                                                        | Login e recuperação coerentes; erros transitórios distintos de permissão; alterações preservadas sob falha e concorrência                                    |
| 5 — Operação e experiência                | CRM-10/12; UX-04/05/07/08; mudanças de cadastro após DEC-01                                                                                                                                                    | Confirmações WAHA, build e portas validados; menus, retorno após login, uso móvel, teclado e mensagens revisados                                             |
| 6 — Consolidação e implantação            | CRM-14, regressão integrada, migrações verificadas, runbooks, implantação gradual e observabilidade                                                                                                            | Checks dos serviços ativos aprovados; evidências, recuperação e acompanhamento registrados                                                                   |

Registrar DEC-01 em paralelo, antes das mudanças dependentes. Adicionar testes e CI junto às entregas; acessibilidade deve acompanhar as telas alteradas. Não há prazo fechado: estimativas dependem do inventário e da reprodução dos cenários.

Não apagar a fila nem reenviar em massa itens em erro para tratar o sintoma. Classificar envios aceitos, não realizados e desconhecidos antes de recuperar itens. Corrigir aceitação ambígua antes de ampliar retries. Coordenar consumidores e migrações incompatíveis de estados/leases na implantação.

<a id="seguranca-infraestrutura"></a>

## 4. Segurança, backend e infraestrutura

### Requisitos de correção por achado

<a id="crm-01"></a>

#### CRM-01 — Autenticar o webhook WAHA do CRM

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

<a id="crm-02"></a>

#### CRM-02 — Proteger a API de chamadas e isolar sessões

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

<a id="crm-03"></a>

#### CRM-03 — Restringir funções privilegiadas do Supabase

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

<a id="crm-04"></a>

#### CRM-04 — Remover credenciais padrão e restringir logs

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

<a id="crm-05"></a>

#### CRM-05 — Tornar privados os anexos de conversas

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

<a id="crm-06"></a>

#### CRM-06 — Aplicar autorização e validação no NestJS

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

<a id="crm-07"></a>

#### CRM-07 — Corrigir concorrência e adiamento no worker NestJS

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

<a id="crm-08"></a>

#### CRM-08 — Restringir downloads de áudio no VoIP

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

<a id="crm-09"></a>

#### CRM-09 — Recusar endpoints operacionais sem segredo

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

<a id="crm-10"></a>

#### CRM-10 — Corrigir confirmações de entrega e leitura WAHA

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

<a id="crm-11"></a>

#### CRM-11 — Respeitar limite horário e pausa entre lotes

**Evidência:** [cron do disparador](../src/app/api/disparador/cron/route.ts). A quantidade já enviada é comparada com o limite, mas a busca usa `batch_size` inteiro. Revisão complementar: `batch_pause_seconds` é aplicado ao `scheduled_at` no enfileiramento em [startCampaign](../src/lib/disparador/startCampaign.ts); o cron não mantém uma pausa baseada na execução real. Quando itens atrasados se acumulam ou ticks extras ocorrem, o agendamento inicial não impede aceleração dos lotes elegíveis. Ver [Crons, duplicação e integrações](#crons-integracoes).

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

<a id="crm-12"></a>

#### CRM-12 — Corrigir e restringir o ambiente Docker

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

<a id="crm-13"></a>

#### CRM-13 — Remover a credencial administrativa do localStorage

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

<a id="crm-14"></a>

#### CRM-14 — Ampliar o CI aos serviços ativos

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

<a id="login-interface"></a>

## 5. Login, interface e usabilidade

### Requisitos por achado

<a id="ux-01"></a>

#### UX-01 — Eliminar ciclos de login no disparador

**Evidência:** [interceptor de API](../disparador/frontend/src/lib/api.ts), [middleware](../disparador/frontend/src/middleware.ts) e [login](../disparador/frontend/src/app/auth/login/page.tsx). Em uma resposta 401, o interceptor apaga o token do `localStorage`, mas deixa o cookie. O middleware redireciona qualquer acesso público com esse cookie para o dashboard. O interceptor também atua no 401 do próprio login.

**Cenários afetados:** sessão inválida com cookie remanescente; tentativa de login com senha incorreta; múltiplas requisições simultâneas retornando 401.

**Requisitos:**

- Centralizar a limpeza do estado de autenticação, incluindo cookie, token armazenado, dados em memória e caches ligados ao usuário.
- Distinguir 401 de `/auth/login` de 401 de uma operação autenticada. Credencial inválida deve manter a pessoa na tela e mostrar o erro, sem recarregar o documento.
- Impedir que a mera presença de um cookie inválido torne o login inacessível. Preservar a validação real no backend.
- Para sessão expirada, limpar o estado uma vez e navegar ao login com uma explicação compreensível. Evitar disputa entre interceptores de requisições simultâneas.
- Não tratar 403, indisponibilidade ou falha de rede como senha incorreta ou expiração de sessão.
- Alinhar duração e expiração dos estados de autenticação para evitar divergência entre cookie e JWT.
- Coordenar com os controles de sessão e proteção de credenciais do parte de segurança, backend e infraestrutura. A correção de navegação não justifica ampliar acesso ao token no navegador.

**Critérios de aceite:**

- [ ] Com cookie antigo/inválido e sem token válido, o usuário chega ao login e permanece nele.
- [ ] Senha incorreta apresenta mensagem em português e permite nova tentativa, sem reload nem ida ao dashboard.
- [ ] Sessão expirada em uma página protegida gera uma única transição ao login.
- [ ] Vários 401 concorrentes não causam ciclos nem múltiplos redirects.
- [ ] Erros 403, 5xx e de rede preservam a distinção entre permissão, serviço indisponível e autenticação.
- [ ] Logout limpa o estado usado pelo middleware e pelo cliente de API.

<a id="ux-02"></a>

#### UX-02 — Diferenciar erro de carregamento e falta de permissão

**Evidência:** [AuthProvider](../src/hooks/use-auth.tsx) e [dashboard shell](<../src/app/(dashboard)/dashboard-shell.tsx>). A falha de busca do perfil é registrada no console; ao terminar o loading com papel vazio, o shell encaminha para `/unauthorized`. Há também um timer de segurança de três segundos na inicialização da sessão que encerra loading sem distinguir timeout de ausência de usuário.

**Impacto:** uma falha transitória pode parecer bloqueio de acesso. A pessoa não recebe explicação adequada nem uma opção clara de recuperação.

**Requisitos:**

- Modelar estados distintos: carregando, autenticado com perfil, não autenticado, erro transitório e perfil/conta ausente ou inválido.
- Expor o erro de carregamento para a interface, sem informações internas do banco.
- Exibir mensagem com ação de tentar novamente quando sessão, perfil ou conta não puderem ser carregados por falha de rede/serviço.
- Não converter timeout de carregamento em prova de logout ou de falta de permissão.
- Encaminhar para falta de permissão apenas quando houver uma decisão de autorização válida. Para perfil sem vínculo, mostrar uma orientação específica de contato com o administrador.
- Prevenir atualizações atrasadas: resultados de uma tentativa anterior ou de outro usuário não devem substituir o estado da tentativa atual.
- Permitir sair/trocar de conta quando o contexto não puder ser recuperado.

**Critérios de aceite:**

- [ ] Falha 5xx ou de rede ao carregar perfil apresenta erro recuperável, não `/unauthorized`.
- [ ] Sessão lenta além de três segundos não é automaticamente tratada como inexistente.
- [ ] Tentar novamente recupera o dashboard quando o serviço volta, sem exigir novo login válido.
- [ ] Perfil realmente sem vínculo recebe mensagem específica e nenhuma capacidade privilegiada.
- [ ] Troca de usuário durante carregamento não exibe perfil nem dados da identidade anterior.

<a id="ux-03"></a>

#### UX-03 — Tornar coerente a recuperação de senha

**Evidência:** [redefinição de senha](<../src/app/(auth)/reset-password/page.tsx>) anuncia retorno ao login e navega para `/login` após três segundos, sem encerrar a sessão. O [middleware](../src/middleware.ts) redireciona sessões presentes para `/dashboard`. O [callback](../src/app/auth/callback/route.ts) envia `error=auth-callback-failed`, mas o [login](<../src/app/(auth)/login/page.tsx>) não apresenta esse motivo.

**Impacto:** promessa de navegação diferente do resultado e ausência de orientação quando o link de recuperação falha.

**Comportamento proposto:** após redefinir a senha, encerrar a sessão atual de recuperação e voltar ao login com confirmação. Se a implementação exigir continuar autenticado, registrar essa decisão e alterar o texto e o destino conjuntamente.

**Requisitos:**

- Alinhar sessão, destino e mensagem de sucesso. Não anunciar retorno ao login enquanto a aplicação redireciona para outro lugar.
- Identificar link ausente, inválido, expirado ou callback malsucedido antes de permitir a redefinição, com orientação para solicitar outro link.
- Usar códigos de erro conhecidos e mensagens próprias; não renderizar conteúdo arbitrário da query nem detalhes internos do provedor.
- Exibir erros de callback na tela apropriada e fornecer recuperação clara.
- Manter as regras de senha coerentes entre cadastro, recuperação, troca de senha e configuração do provedor, informando-as antes de enviar o formulário.
- Garantir que erro inesperado libere o estado de loading e preserve os campos necessários para nova tentativa.
- Validar o fluxo real de e-mail na configuração de homologação, incluindo redirects permitidos e abertura do link em outro navegador/dispositivo. Documentar eventuais limitações do mecanismo utilizado.

**Critérios de aceite:**

- [ ] Link válido permite redefinir e conduz ao destino anunciado.
- [ ] Link inválido/expirado apresenta motivo compreensível e ação para solicitar outro.
- [ ] Erro de callback não desaparece silenciosamente ao abrir o login.
- [ ] Senhas divergentes ou fora da política são informadas antes da chamada de atualização quando detectáveis no cliente.
- [ ] Falha de rede permite tentar novamente e não deixa o botão permanentemente carregando.
- [ ] O comportamento de link aberto em outro navegador/dispositivo é verificado e documentado.

<a id="ux-04"></a>

#### UX-04 — Alinhar menus às permissões e oferecer troca da própria senha

**Evidência:** [header](../src/components/layout/header.tsx), [sidebar](../src/components/layout/sidebar.tsx) e [allowlist](../src/lib/role-utils.ts). Configurações aparece no menu da conta sem filtro de papel; Meu Perfil aparece para viewer, mas `/perfil` não aceita viewer. O caminho específico de troca de senha para agentes não oferece equivalente ao viewer.

**Impacto:** links sem resultado útil e ausência de autosserviço de senha para um perfil legítimo.

**Requisitos:**

- Utilizar capacidades e regras comuns para menu lateral, menu da conta e proteção de rotas. Evitar regras independentes que divergem entre si.
- Exibir apenas links acessíveis ou, quando útil ao produto, um estado explicitamente indisponível com motivo e sem navegação inútil.
- Permitir a todos os papéis autenticados gerenciar sua própria senha, sem conceder acesso às configurações da organização.
- Usar uma rota pessoal restrita ou diálogo específico. Não liberar `/settings` inteira para solucionar a troca de senha.
- Manter autorização no backend; ocultar menu é apenas comportamento de interface.
- Em acesso direto a destino proibido, apresentar explicação e retorno para uma rota permitida ao papel.
- Padronizar esses comportamentos no desktop e no menu móvel.

**Critérios de aceite:**

- [ ] Owner, admin, agent e viewer visualizam destinos compatíveis com suas capacidades.
- [ ] Viewer consegue trocar somente a própria senha, sem acessar administração da conta.
- [ ] Agent não recebe link de Configurações que simplesmente o devolve ao inbox.
- [ ] Menu da conta e menu lateral não divergem sobre o mesmo destino.
- [ ] Acesso direto a rota proibida continua bloqueado e oferece retorno válido.

<a id="ux-05"></a>

#### UX-05 — Preservar o destino original depois do login

**Evidência:** [login do CRM](<../src/app/(auth)/login/page.tsx>) escolhe convite ou `/dashboard`; [middleware do CRM](../src/middleware.ts), [dashboard shell](<../src/app/(dashboard)/dashboard-shell.tsx>) e [middleware do disparador](../disparador/frontend/src/middleware.ts) não implementam um fluxo completo de retorno ao destino protegido solicitado.

**Impacto:** ao abrir um link interno sem sessão, a pessoa perde o caminho da tarefa e precisa encontrá-la novamente.

**Requisitos:**

- Propagar um destino de retorno nas transições ao login, preservando caminho e parâmetros necessários à tarefa.
- Validar o destino em cada ponto de consumo: aceitar somente destinos internos autorizáveis; recusar URLs externas, esquemas, caminhos ambíguos e rotas que provoquem loops.
- Não propagar parâmetros de diagnóstico ou dados sensíveis desnecessários para URLs de retorno.
- Após autenticar, validar a permissão sobre rota/recurso antes de apresentar dados.
- Definir precedência com convites: preservar o fluxo de aceitação e consumir eventual destino posterior somente quando apropriado.
- Usar a rota padrão do papel quando não houver destino válido. Não obrigar agentes a passar pelo dashboard que não podem acessar.
- Implementar o mesmo contrato nos dois frontends, respeitando suas rotas distintas de login.

**Critérios de aceite:**

- [ ] Link interno protegido leva ao login e retorna ao mesmo destino permitido após autenticação.
- [ ] Parâmetros necessários de filtro/seleção são preservados.
- [ ] Destino externo, inválido ou que aponta de volta ao login é rejeitado sem loop.
- [ ] Usuário sem permissão recebe orientação ou fallback permitido, sem acesso indevido ao recurso.
- [ ] Convites existentes continuam funcionando e login sem destino respeita a rota padrão do papel.

<a id="ux-06"></a>

#### UX-06 — Preservar alterações no editor de fluxos

**Evidência:** [estado do editor](../src/components/flows/flow-editor-state.tsx) usa autosave com debounce de dois segundos; ao desmontar, o timer é cancelado. As ações do [header](../src/components/flows/header.tsx) chamam `save` sem aguardar sucesso antes de navegar. O handler de `beforeunload` não cobre navegação interna pelo menu lateral.

**Impacto:** alterações feitas imediatamente antes de navegar podem não persistir; falhas de salvamento podem deixar o usuário fora do editor com trabalho pendente.

**Requisitos:**

- Tornar o estado de salvamento observável: alterações pendentes, salvando, salvo e erro. Não depender apenas de toast temporário.
- Fazer `save` devolver um resultado consumível pelo chamador, distinguindo sucesso, falha e salvamento já em andamento.
- Coordenar autosave e navegação para persistir a versão mais recente. Mudanças feitas durante um save anterior não podem ser marcadas como salvas pelo término daquela requisição.
- Nas saídas controladas pelo editor, aguardar confirmação de persistência ou apresentar opções de tentar novamente, permanecer e descartar explicitamente.
- Cobrir saídas pelo menu lateral, histórico do navegador e outras rotas internas usando mecanismo compatível com a versão Next.js instalada. Caso a interceptação não seja suficiente, manter rascunho recuperável para as saídas restantes.
- Para fechar/recarregar a aba, usar proteção nativa e/ou rascunho recuperável; `keepalive` não deve ser a única garantia de preservação.
- Se persistir rascunho local, isolá-lo por usuário/conta/fluxo, definir limpeza e não armazenar segredos presentes na configuração dos nós em storage inseguro.
- Não bloquear navegação quando não houver alteração pendente.

**Critérios de aceite:**

- [ ] Editar e sair em menos de dois segundos pelo menu lateral preserva o trabalho ou solicita descarte explícito.
- [ ] Falha de API ao salvar mantém possibilidade de recuperação e informa o usuário.
- [ ] Alteração feita durante uma requisição anterior continua pendente até ser realmente persistida.
- [ ] Voltar/avançar no navegador e recarregar a aba seguem a estratégia definida de proteção/recuperação.
- [ ] Descarte explícito não restaura indevidamente o rascunho na próxima abertura.
- [ ] Salvamento concluído não gera prompts desnecessários nem guarda dados sensíveis em rascunhos inseguros.

<a id="ux-07"></a>

#### UX-07 — Adaptar o disparador auxiliar a telas pequenas

**Evidência:** [sidebar do disparador](../disparador/frontend/src/components/layout/Sidebar.tsx) tem largura fixa `w-64`, sem variante de gaveta ou breakpoints, e ocupa espaço permanentemente fora de iframe. Os [layouts](../disparador/frontend/src/app/dashboard/layout.tsx) posicionam menu e conteúdo lado a lado.

**Impacto provável:** conteúdo comprimido em celular e navegação difícil nas telas operacionais. Reproduzir visualmente para confirmar a extensão do problema.

**Requisitos:**

- Manter menu lateral no desktop e usar gaveta em telas pequenas, com acionador visível no cabeçalho.
- Fechar a gaveta ao escolher destino, pressionar Escape ou usar a ação de fechamento; devolver foco ao acionador quando apropriado.
- Impedir interação/foco no conteúdo de fundo enquanto a gaveta estiver aberta e anunciar seu propósito às tecnologias assistivas.
- Preservar o comportamento embutido em iframe sem deixar o usuário sem as ações de conta necessárias.
- Adaptar layouts de dashboard, campanhas, contatos, sessões, atendimento e blacklist; tratar tabelas largas com rolagem própria ou apresentação alternativa.
- Evitar que apenas ocultar o menu torne conteúdo inacessível. Verificar formulários, modais e ações de confirmação com teclado virtual aberto.

**Critérios de aceite:**

- [ ] Em 320, 375 e 768 px de largura, o menu não ocupa permanentemente o espaço de leitura principal.
- [ ] Em desktop, navegação e conteúdo mantêm comportamento adequado.
- [ ] Toda rota do menu é alcançável por toque e teclado.
- [ ] Gaveta possui foco controlado, fechamento acessível e retorno de foco.
- [ ] Modais e formulários essenciais continuam utilizáveis com teclado virtual e zoom de 200%.
- [ ] Uso em iframe não apresenta regressão de navegação ou de acesso às ações previstas.

<a id="ux-08"></a>

#### UX-08 — Corrigir acessibilidade e padronizar mensagens

**Evidência:** [composer de mensagens](../src/components/inbox/message-composer.tsx) tem botão Enviar somente com ícone, sem nome acessível explícito; [formulários de acesso](<../src/app/(auth)/login/page.tsx>) exibem erros sem região de anúncio. Existem mensagens em inglês no [shell](<../src/app/(dashboard)/dashboard-shell.tsx>), nos uploads e no [GatedButton](../src/components/ui/gated-button.tsx). O [login do disparador](../disparador/frontend/src/app/auth/login/page.tsx) utiliza labels sem associação explícita aos inputs.

**Requisitos confirmados pelo código:**

- Dar nome acessível às ações só com ícone, começando por enviar mensagem e controles de atendimento. Preservar nomes consistentes entre tooltip e anúncio.
- Associar labels, instruções e erros aos campos. Usar estado inválido e região de anúncio para erros; aplicar `aria-busy`/status quando útil ao carregamento.
- Inserir atributos adequados de autocomplete em e-mail, senha atual e nova senha, mantendo suporte a gerenciadores de senha e colagem.
- Traduzir textos operacionais visíveis para português do Brasil, incluindo loading, upload e explicações de somente leitura.
- Mapear erros conhecidos do provedor para mensagens compreensíveis; separar credencial inválida, limitação de tentativas, indisponibilidade e problemas de conexão.
- Não depender apenas de cor, hover ou tooltip para comunicar bloqueio ou falha; oferecer explicação alcançável por teclado e toque.

**Verificações complementares, ainda sem falha visual confirmada:**

- Conferir contraste, ordem e visibilidade de foco, reflow, zoom e tamanho de áreas de toque nas telas essenciais.
- Validar uso por teclado e leitor de tela, com análise automatizada como apoio, não como prova única.
- Avaliar mostrar/ocultar senha como melhoria, sem alterar a política de segurança ou impedir gerenciadores de senha.

**Critérios de aceite:**

- [ ] Leitor de tela identifica o botão de envio e os campos de login sem depender de contexto visual.
- [ ] Erro de formulário é anunciado e associado ao campo quando aplicável.
- [ ] Login, recuperação, menu e ações essenciais funcionam por teclado, com foco visível e sem aprisionamento indevido.
- [ ] Textos revisados de acesso, loading, upload e bloqueios por papel estão em português.
- [ ] Usuário distingue falha de rede de credencial inválida sem receber detalhes internos do provedor.
- [ ] Gerenciador de senha consegue identificar campos e preenchê-los, com atributos apropriados.
- [ ] Avaliação visual registra resultados de contraste, zoom e toque; falhas encontradas viram tarefas rastreáveis.

<a id="dec-01"></a>

### DEC-01 — Definir a política de cadastro do CRM interno

**Evidência:** [login](<../src/app/(auth)/login/page.tsx>) oferece Criar conta; [cadastro](<../src/app/(auth)/signup/page.tsx>) permite chamar `signUp` sem convite. O código disponível não informa se a operação pretende aceitar cadastros públicos.

**Classificação:** decisão pendente, não uma vulnerabilidade comprovada de cadastro. Não alterar a política automaticamente nem presumir que criar conta conceda acesso à organização existente.

| Alternativa     | Comportamento esperado                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Somente convite | Usuário novo ingressa por convite autorizado; registro fora desse caminho é impedido no controle efetivo de autenticação/provisionamento, não apenas ocultado na tela |
| Cadastro aberto | Usuário pode criar uma conta própria; onboarding explica o processo e a nova identidade não ganha acesso a organizações existentes sem autorização                    |

**Ações após a decisão:**

- Registrar a alternativa aprovada e quem a definiu.
- Alinhar login, signup, mensagens de confirmação, provisionamento e configuração do Supabase à alternativa escolhida.
- Validar convites inválidos, expirados e já utilizados, inclusive para usuários existentes.
- Tratar cadastro com confirmação de e-mail habilitada ou desabilitada: a UI deve refletir se há sessão pronta ou confirmação pendente, sem sempre prometer um e-mail inexistente.
- Se cadastro aberto for mantido, confirmar isolamento de contas e onboarding compatível. Se convite for obrigatório, verificar que registro direto na API não contorne a política.

**Critérios de aceite dependentes da decisão:**

- [ ] Política e configuração efetiva correspondem ao comportamento exibido na interface.
- [ ] Ocultar Criar conta não é a única restrição quando a política exigir convite.
- [ ] Cadastro/convite não concede acesso indevido a uma conta existente.
- [ ] Mensagem de sucesso corresponde ao estado real de confirmação e sessão.
- [ ] Fluxos válidos de convite continuam operacionais.

### Padrões comuns de experiência

| Situação                     | Resposta esperada                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Credencial inválida          | Mensagem objetiva no formulário; permitir correção sem reload                               |
| Sessão expirada              | Explicar expiração, limpar estado inválido e permitir login; manter retorno seguro à tarefa |
| Falha transitória            | Explicar indisponibilidade/conexão e oferecer nova tentativa                                |
| Falta de permissão real      | Explicar restrição e oferecer destino permitido                                             |
| Perfil sem vínculo           | Orientar contato com administrador, sem sugerir senha incorreta                             |
| Link de recuperação inválido | Oferecer solicitação de novo link                                                           |
| Alterações pendentes         | Mostrar estado e preservar trabalho ou pedir descarte explícito                             |
| Salvamento concluído         | Confirmar persistência da versão efetivamente salva                                         |
| Ação bloqueada pelo papel    | Explicação compreensível, inclusive por teclado e toque                                     |

### Dependências com segurança, backend e infraestrutura

| Itens deste documento | Dependência / alinhamento                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| UX-01, UX-03, UX-05   | Autenticação real e limpeza de sessão não podem ser substituídas por presença de cookie ou redirect |
| UX-02, UX-04          | Regras de UI devem usar as mesmas capacidades aplicadas no backend; alinhar com CRM-06              |
| UX-07                 | Validar frontend/container ativo e implantação corrigida em CRM-12                                  |
| UX-08                 | Aplicar também ao acesso administrativo revisado em CRM-04/CRM-13 quando as telas forem alteradas   |
| Todos os itens        | Adicionar testes relevantes ao CI definido em CRM-14, sem credenciais ou mensagens reais            |

<a id="crons-integracoes"></a>

## 6. Crons, duplicação e integrações

### Conclusão da investigação e limites

Há caminhos concretos no código que permitem repetir operações externas ou ampliar a carga. Não é possível atribuir o incidente reportado a uma causa única sem correlacionar logs, filas, IDs Meta e agendadores ativos.

Esta investigação não executou crons, testes de stress, mensagens WhatsApp nem chamadas aos sistemas integrados. Não houve acesso ao banco, servidor, agendadores ou métricas de produção. A documentação oficial da Meta sobre códigos de erro retornou HTTP 429 durante a consulta; classificações de códigos precisam de verificação posterior, sem adotar comentários do código como contrato oficial.

Este documento registra falhas e cenários de concorrência identificáveis por leitura. Não declara duplicação observada em produção nem garante envio exatamente uma vez apenas com uma trava no banco.

#### Proteções que já existem

- O processador Next.js reivindica cada item com `UPDATE` condicionado a `status='agendado'`. Duas chamadas normais concorrentes não deveriam ganhar a mesma reivindicação enquanto o status continuar `enviando`.
- O início de campanha Next.js também usa uma alteração condicional para evitar dois inícios normais de rascunho/agendamento.
- Automations e a retomada de flows atrasados têm alterações condicionais de status antes do processamento.
- O webhook Meta ignora duplicidade de mensagem recebida quando o índice único da migração 088 está aplicado e a inserção retorna `23505`.

Essas proteções não cobrem todos os efeitos externos, a recuperação de envio ambíguo, a finalização de campanha, a carga agregada ou o worker NestJS. Repetir uma chamada de cron não equivale necessariamente a repetir a mesma mensagem; pode também antecipar novos envios e aumentar a carga.

### Requisitos por achado

<a id="cron-01"></a>

#### CRON-01 — Separar diagnóstico de execução operacional

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

<a id="cron-02"></a>

#### CRON-02 — Recuperar envio ambíguo sem reenvio cego

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

<a id="cron-03"></a>

#### CRON-03 — Diferenciar falha de envio de falha de persistência

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

<a id="cron-04"></a>

#### CRON-04 — Impedir competição do worker NestJS

**Evidência:** [worker NestJS](../disparador/backend/src/message-queue/message-queue.worker.ts) faz SELECT de item agendado e UPDATE somente por ID. A variável `processing` existe apenas dentro da instância. O loop inicia automaticamente fora de Vercel; [process-tick](../disparador/backend/src/message-queue/message-queue.controller.ts) também pode acioná-lo.

**Correção necessária:**

- Inventariar instâncias e decidir qual serviço consome cada fila, incluindo topologia/schema real do NestJS.
- Tornar o modo de consumo explícito: worker contínuo ou scheduler, com comportamento conhecido ao escalar réplicas.
- Usar reivindicação atômica comum no banco e identificação de dono, compatível com os demais consumidores ativos.
- Não confiar em flag em memória para exclusão entre instâncias.
- Corrigir adiamentos que deixam o item em `enviando`, conforme CRM-07 do parte de segurança, backend e infraestrutura.

**Aceite:**

- [ ] Duas instâncias disputando o mesmo item produzem um vencedor.
- [ ] Consumidores diferentes não enviam o mesmo item por protocolos incompatíveis.
- [ ] Modo de execução e serviços ativos estão documentados no deploy.

<a id="cron-05"></a>

#### CRON-05 — Publicar campanha para consumo somente após preparar a fila

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

<a id="cron-06"></a>

#### CRON-06 — Concluir campanha e emitir callback com idempotência

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

<a id="cron-07"></a>

#### CRON-07 — Tornar eventos de status Meta seguros para retries

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

<a id="cron-08"></a>

#### CRON-08 — Tratar erro ao registrar sucesso sem perder a entrega externa

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

<a id="cron-09"></a>

#### CRON-09 — Controlar carga agregada por canal e integração

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

<a id="cron-10"></a>

#### CRON-10 — Aplicar pausa pela execução real, inclusive com backlog

**Precisão em relação à primeira auditoria:** a pausa não está completamente ausente. [startCampaign](../src/lib/disparador/startCampaign.ts) espaça `scheduled_at` dos lotes; o [cron](../src/app/api/disparador/cron/route.ts) consome quaisquer itens já vencidos e não persiste um próximo horário por lote efetivamente executado.

**Cenário:** scheduler parado acumula lotes vencidos; ticks repetidos consomem os lotes em cadência acelerada. A pausa inicial já ficou no passado e não limita a recuperação.

**Correção necessária:**

- Persistir próximo lote permitido pela execução efetiva e reservar essa janela de forma atômica.
- Definir explicitamente se a pausa conta do início ou término do lote; proposta: término do lote aceito/processado.
- Aplicar a mesma regra na retomada de backlog, cron extra, retry e execução manual operacional.

**Aceite:**

- [ ] Pausa de 180 segundos continua respeitada quando todos os lotes estão atrasados.
- [ ] Ticks extras não antecipam o próximo lote permitido.

<a id="cron-11"></a>

#### CRON-11 — Evitar respostas concorrentes da IA global

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

<a id="cron-12"></a>

#### CRON-12 — Padronizar deadlines, retomada e proteção das integrações

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

<a id="diagnostico-producao"></a>

## 7. Diagnóstico em produção

### Diagnóstico necessário em produção — somente leitura

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

<a id="validacao"></a>

## 8. Validação, implantação e observabilidade

### Validação integrada

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

### Implantação, migrações e recuperação

- Registrar a versão dos serviços, as migrações aplicadas e os grants antes da mudança. Preparar backup e validar recuperação antes de migrações de dados.
- Provisionar segredos e configurar emissores/schedulers antes de ativar a exigência correspondente. Evitar uma janela que aceite requisições sem credencial.
- Coordenar a fronteira CRM/Go e a adaptação dos clientes para não interromper chamadas válidas.
- Aplicar novas migrações e validar permissões reais. Não tratar edição de arquivo SQL antigo como atualização automática do banco existente.
- Para fila, interromper ou coordenar consumidores durante alterações incompatíveis de estado/lease; identificar envios em andamento antes de retomá-los.
- Para mídia, adaptar leitores e remetentes antes de fechar o bucket, migrar referências e só então validar a retirada das URLs públicas.
- Para rollback, preservar fechamento de acesso e privacidade: restaurar a aplicação para uma versão compatível ou desabilitar temporariamente a funcionalidade afetada. Não reintroduzir senha padrão, webhook aberto ou bucket público como recuperação automática.
- Após implantação, acompanhar rejeições de autenticação, falhas de integração, itens presos, duplicações, quota, atraso de fila e erros de leitura de mídia.

### Plano de testes e revisão visual

#### Ambiente e identidades

- Homologação com dados sintéticos e serviços externos simulados quando possível.
- Usuários owner, admin, agent e viewer; ao menos duas contas independentes para testar isolamento.
- Estados de sessão válida, expirada, cookie remanescente, token ausente, perfil sem vínculo e rede indisponível.
- Convites e links de recuperação de homologação, sem credenciais de produção.

#### Cenários de regressão

| Cenário                               | Resultado esperado                                        | Cobertura    |
| ------------------------------------- | --------------------------------------------------------- | ------------ |
| Senha errada no disparador            | Erro permanece visível; formulário permite nova tentativa | UX-01, UX-08 |
| Cookie antigo com 401                 | Estado é limpo e login fica acessível, sem ciclo          | UX-01        |
| Perfil retorna 5xx                    | Erro recuperável com nova tentativa                       | UX-02        |
| Inicialização de sessão lenta         | Timeout não vira prova de logout/falta de permissão       | UX-02        |
| Link de recuperação válido/expirado   | Destino coerente ou solicitação de novo link              | UX-03        |
| Menu por papel                        | Apenas destinos compatíveis; própria senha disponível     | UX-04        |
| Deep link antes do login              | Retorno seguro ao destino permitido                       | UX-05        |
| Edição seguida de saída imediata      | Persistência ou descarte explícito; recuperação em falha  | UX-06        |
| Nova edição durante save em andamento | Estado recente não é marcado incorretamente como salvo    | UX-06        |
| Menu móvel e iframe                   | Conteúdo utilizável e ações previstas alcançáveis         | UX-07        |
| Teclado, leitor de tela e zoom        | Campos, erros e ações essenciais compreensíveis           | UX-08        |
| Signup com/sem convite                | Resultado corresponde à política e à configuração real    | DEC-01       |

#### Matriz visual mínima

- Desktop em Chromium e Firefox; Safari quando disponível no ambiente de avaliação.
- Android/Chrome e iOS/Safari para os fluxos móveis, quando houver dispositivos/ambientes disponíveis; registrar qualquer lacuna.
- Larguras de referência: 320, 375, 768 e 1440 px; zoom de 200%; tema claro e escuro quando suportados.
- Login, recuperação, dashboard, menu da conta, inbox, editor e telas principais do disparador.
- Teclado virtual aberto em formulários móveis e foco após fechar modais/gavetas.
- Avaliação automatizada de acessibilidade complementada por execução manual por teclado e leitor de tela.

### Implantação e acompanhamento

- Publicar frontend, middleware e ajustes de sessão de forma coordenada, verificando compatibilidade com os controles do backend.
- Aplicar a limpeza necessária de cookies/tokens legados sem apagar rascunhos válidos do usuário ou dados não relacionados.
- Nas mudanças do editor, validar migração e recuperação de rascunhos eventualmente existentes. Nunca tratar falha de save como autorização para descartar dados.
- Medir loops/redirects repetidos, erros de perfil, falhas de recuperação e salvamento com dados operacionais mínimos; não registrar senhas, tokens, links de recuperação completos ou conteúdo sensível dos fluxos.
- Em regressão de autenticação, preservar autorização e limpeza de estado; não restaurar redirecionamento baseado apenas em cookie inválido como solução.
- Fazer revisão com usuários operacionais em homologação, registrando tarefas concluídas, bloqueios encontrados e ajustes necessários.

### Testes obrigatórios de regressão

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

### Observabilidade e conclusão

Adicionar IDs de execução, origem do acionamento, operação/tentativa e canal aos registros operacionais. Medir crons recebidos/pulados, itens reivindicados, envios aceitos, resultados desconhecidos, reconciliações, retries, mensagens duplicadas confirmadas e latência/429 por integração.

Não registrar tokens, URLs com segredos, CPFs completos ou conteúdo integral de mensagens como condição de diagnóstico.

- [ ] Causa(s) do incidente correlacionadas com evidência real, ou incertezas explicitamente registradas.
- [ ] CRON-01 a CRON-12 corrigidos e validados, ou serviço descontinuado retirado formalmente.
- [ ] Protocolos de idempotência, claim, recuperação e cadência testados sob concorrência e falhas simuladas.
- [ ] Configuração efetiva de agendadores, consumidores e ambientes registrada.
- [ ] Migrações aplicadas e verificadas; sem dependência silenciosa de fallback inseguro.
- [ ] CI e testes relevantes executados; nesta investigação não foram executados por ausência de runtime/dependências.
- [ ] Implantação acompanhada por métricas que distingam envio novo, reentrega de evento e callback repetido.

<a id="conclusao"></a>

## 9. Decisões técnicas e conclusão

### Decisões a registrar antes das implementações dependentes

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

### Definição de conclusão unificada

- [ ] Todos os IDs CRM, UX e CRON possuem implementação e evidências dos critérios aplicáveis, ou retirada formal do serviço afetado com comprovação de que não permanece exposto.
- [ ] DEC-01 possui política registrada, configuração correspondente e testes de cadastro/convite. Decisão pendente não deve ser marcada como concluída.
- [ ] O incidente de duplicação tem causa correlacionada com evidência ou incertezas explicitamente documentadas; os cenários identificados no código foram tratados conforme aplicabilidade.
- [ ] Build, lint, typecheck e testes relevantes dos serviços ativos estão registrados e aprovados; análise estática não substitui execução.
- [ ] Migrações, grants, segredos, rede, agendadores e consumidores foram conferidos no ambiente de destino.
- [ ] Atendimento, envio manual/API, campanhas, IA, anexos, confirmações e chamadas permanecem operacionais para usuários autorizados.
- [ ] Login, logout, recuperação, navegação por papel, salvamento de fluxos, uso móvel e acessibilidade essencial possuem validação prática.
- [ ] Quota agregada, pausa real, recuperação, eventos e efeitos externos foram testados com concorrência e falhas simuladas, sem envios reais nos testes.
- [ ] Runbooks de implantação, recuperação de filas, rotação de segredos e suporte estão atualizados.
- [ ] Cada entrega registra arquivos alterados, testes, limitações e procedimento de implantação/recuperação.
- [ ] O acompanhamento distingue envio novo, repetição de webhook, callback repetido e resultado externo desconhecido.

### Como registrar o progresso

Usar os IDs nas tarefas e PRs. Atualizar o backlog único com estados como Não iniciado, Em andamento, Em validação, Bloqueado com motivo ou Concluído. Para cada entrega, registrar abaixo os IDs atendidos, responsável, link da tarefa/PR, alterações/migrações, resultados dos testes, evidência de homologação e implantação, e limitações remanescentes. Não concluir um ID apenas porque outro relacionado foi implementado.

| Data       | IDs                            | Responsável             | Tarefa/PR                    | Validação e ambiente                    | Implantação/recuperação                               | Pendências                                              |
| ---------- | ------------------------------ | ----------------------- | ---------------------------- | --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| 01/10/2026 | IDs em validação parcial acima | A designar para revisão | fix/crm-reliability-security | Testes locais registrados na Entrega 01 | Migrações 118/119 e configuração WAHA antes do deploy | Critérios restantes e diagnóstico de produção pendentes |
