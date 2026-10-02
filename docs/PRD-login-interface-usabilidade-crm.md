# PRD 02 — Login, interface e usabilidade do CRM interno

> **Histórico:** este PRD foi consolidado no [PRD unificado — Correções do CRM](./PRD-unificado-correcao-crm.md). Usar o documento unificado para implementar e atualizar o progresso.

| Campo                 | Valor                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Data                  | 01/10/2026                                                                                                                 |
| Status                | Proposta para implementação; correções ainda não executadas                                                                |
| Escopo                | Autenticação, recuperação de acesso, navegação por perfil, editor de fluxos, interface móvel e acessibilidade              |
| Origem                | Revisão estática adicional do frontend e dos fluxos de autenticação                                                        |
| Documento relacionado | [PRD 01 — Correções de segurança, backend e infraestrutura](./PRD-correcao-auditoria-crm.md)                               |
| Objetivo              | Eliminar barreiras de acesso, navegação sem resultado e perda de alterações; tornar a interface compreensível e utilizável |

## 1. Contexto e limites

Este documento cobre oito achados adicionais e uma decisão de produto sobre cadastro. Complementa o primeiro PRD e não substitui os controles de autorização e segurança definidos nele.

O CRM principal e o frontend auxiliar do disparador têm fluxos de autenticação diferentes. Cada requisito identifica o serviço afetado; não se deve aplicar uma correção a um deles e presumir que o outro foi corrigido.

Limites da análise:

- Os caminhos descritos foram identificados no código. Não houve execução da aplicação nem teste visual em navegador, celular ou leitor de tela.
- Build, lint, testes e acesso ao ambiente de produção permanecem pendentes, pelos limites de runtime e dependências registrados no PRD 01.
- A ocorrência de ciclos de redirecionamento depende do estado de cookies e tokens. A compressão do conteúdo móvel é inferida do layout fixo e deve ser reproduzida antes e depois da correção.
- Contraste, zoom, foco real, teclado virtual e comportamento entre navegadores precisam de validação prática. Não são falhas visuais já comprovadas por esta revisão.
- Nenhum código de aplicação foi alterado para produzir este documento.
- Antes de implementar código Next.js, instalar as dependências e ler os guias pertinentes em `node_modules/next/dist/docs/`, conforme `AGENTS.md`.

## 2. Objetivos

1. Permitir login, logout e recuperação de senha sem ciclos ou mensagens contraditórias.
2. Diferenciar credencial inválida, sessão expirada, falha de rede e falta de permissão.
3. Exibir apenas destinos compatíveis com as capacidades do usuário e permitir gerenciamento da própria senha.
4. Retomar a tarefa originalmente solicitada após o login, quando autorizada.
5. Preservar alterações de fluxos durante salvamento e navegação.
6. Tornar o disparador utilizável em telas pequenas e as ações essenciais acessíveis por teclado e tecnologias assistivas.
7. Definir explicitamente como usuários podem ingressar no CRM interno.

### Fora do escopo

- Redesenho completo da identidade visual ou de todas as telas.
- Substituição do provedor de autenticação.
- Alteração automática da política de cadastro sem decisão registrada.
- Implementação de todos os itens de segurança do PRD 01 dentro deste trabalho.
- Declaração de conformidade integral de acessibilidade sem avaliação correspondente.

## 3. Priorização

- **P1 — Alta:** impede acesso, gera recuperação incorreta ou pode causar perda de trabalho.
- **P2 — Média:** dificulta navegação, uso móvel, acessibilidade ou compreensão.
- **Decisão pendente:** política de produto que precisa ser definida antes das mudanças dependentes.

| ID     | Tema                                                  | Prioridade       | Serviço                    | Responsável sugerido                    |
| ------ | ----------------------------------------------------- | ---------------- | -------------------------- | --------------------------------------- |
| UX-01  | Ciclos de login e tratamento de 401                   | P1               | Disparador auxiliar        | Frontend + Backend                      |
| UX-02  | Falha de perfil apresentada como falta de permissão   | P1               | CRM principal              | Frontend + Backend                      |
| UX-03  | Recuperação de senha e erros de callback              | P1               | CRM principal              | Frontend + Autenticação                 |
| UX-04  | Menu incompatível com perfil e acesso à própria senha | P2               | CRM principal              | Frontend + Produto                      |
| UX-05  | Retorno ao destino original após login                | P2               | CRM principal e disparador | Frontend + Autenticação                 |
| UX-06  | Preservação de alterações no editor de fluxos         | P1               | CRM principal              | Frontend + Backend                      |
| UX-07  | Navegação móvel do disparador                         | P2               | Disparador auxiliar        | Frontend                                |
| UX-08  | Acessibilidade e textos de interface                  | P2               | CRM principal e disparador | Frontend + Produto                      |
| DEC-01 | Cadastro aberto ou somente por convite                | Decisão pendente | CRM principal              | Responsável pelo produto + Autenticação |

## 4. Requisitos por achado

### UX-01 — Eliminar ciclos de login no disparador

**Evidência:** [interceptor de API](../disparador/frontend/src/lib/api.ts), [middleware](../disparador/frontend/src/middleware.ts) e [login](../disparador/frontend/src/app/auth/login/page.tsx). Em uma resposta 401, o interceptor apaga o token do `localStorage`, mas deixa o cookie. O middleware redireciona qualquer acesso público com esse cookie para o dashboard. O interceptor também atua no 401 do próprio login.

**Cenários afetados:** sessão inválida com cookie remanescente; tentativa de login com senha incorreta; múltiplas requisições simultâneas retornando 401.

**Requisitos:**

- Centralizar a limpeza do estado de autenticação, incluindo cookie, token armazenado, dados em memória e caches ligados ao usuário.
- Distinguir 401 de `/auth/login` de 401 de uma operação autenticada. Credencial inválida deve manter a pessoa na tela e mostrar o erro, sem recarregar o documento.
- Impedir que a mera presença de um cookie inválido torne o login inacessível. Preservar a validação real no backend.
- Para sessão expirada, limpar o estado uma vez e navegar ao login com uma explicação compreensível. Evitar disputa entre interceptores de requisições simultâneas.
- Não tratar 403, indisponibilidade ou falha de rede como senha incorreta ou expiração de sessão.
- Alinhar duração e expiração dos estados de autenticação para evitar divergência entre cookie e JWT.
- Coordenar com os controles de sessão e proteção de credenciais do PRD 01. A correção de navegação não justifica ampliar acesso ao token no navegador.

**Critérios de aceite:**

- [ ] Com cookie antigo/inválido e sem token válido, o usuário chega ao login e permanece nele.
- [ ] Senha incorreta apresenta mensagem em português e permite nova tentativa, sem reload nem ida ao dashboard.
- [ ] Sessão expirada em uma página protegida gera uma única transição ao login.
- [ ] Vários 401 concorrentes não causam ciclos nem múltiplos redirects.
- [ ] Erros 403, 5xx e de rede preservam a distinção entre permissão, serviço indisponível e autenticação.
- [ ] Logout limpa o estado usado pelo middleware e pelo cliente de API.

### UX-02 — Diferenciar erro de carregamento e falta de permissão

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

### UX-03 — Tornar coerente a recuperação de senha

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

### UX-04 — Alinhar menus às permissões e oferecer troca da própria senha

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

### UX-05 — Preservar o destino original depois do login

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

### UX-06 — Preservar alterações no editor de fluxos

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

### UX-07 — Adaptar o disparador auxiliar a telas pequenas

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

### UX-08 — Corrigir acessibilidade e padronizar mensagens

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

## 5. DEC-01 — Definir a política de cadastro do CRM interno

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

## 6. Padrões comuns de experiência

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

## 7. Dependências com o primeiro PRD

| Itens deste documento | Dependência / alinhamento                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| UX-01, UX-03, UX-05   | Autenticação real e limpeza de sessão não podem ser substituídas por presença de cookie ou redirect |
| UX-02, UX-04          | Regras de UI devem usar as mesmas capacidades aplicadas no backend; alinhar com CRM-06              |
| UX-07                 | Validar frontend/container ativo e implantação corrigida em CRM-12                                  |
| UX-08                 | Aplicar também ao acesso administrativo revisado em CRM-04/CRM-13 quando as telas forem alteradas   |
| Todos os itens        | Adicionar testes relevantes ao CI definido em CRM-14, sem credenciais ou mensagens reais            |

## 8. Plano de execução

| Etapa                        | Entregas                                                                                            | Validação para avançar                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0 — Preparação               | Ambiente executável, fixtures, usuários por papel, dados sintéticos e inventário de serviços ativos | Fluxos atuais reproduzidos; limitações de runtime resolvidas ou registradas         |
| 1 — Acesso e recuperação     | UX-01, UX-02 e UX-03                                                                                | Sem ciclos de login; erro de conexão distinto de permissão; recuperação consistente |
| 2 — Preservação do trabalho  | UX-06                                                                                               | Navegação e concorrência de saves não perdem alterações nos cenários definidos      |
| 3 — Navegação e uso móvel    | UX-04, UX-05 e UX-07                                                                                | Destinos por papel, retorno à tarefa e menu móvel validados                         |
| 4 — Clareza e acessibilidade | UX-08, junto às telas alteradas nas etapas anteriores                                               | Teclado, anúncios, idioma e verificações visuais registrados                        |
| Decisão em paralelo          | DEC-01                                                                                              | Executar mudanças dependentes somente após registrar a política                     |

Não há prazo fechado. Estimativas dependem de reprodução, versões instaladas e alcance dos ajustes no editor e nas sessões.

## 9. Plano de testes e revisão visual

### Ambiente e identidades

- Homologação com dados sintéticos e serviços externos simulados quando possível.
- Usuários owner, admin, agent e viewer; ao menos duas contas independentes para testar isolamento.
- Estados de sessão válida, expirada, cookie remanescente, token ausente, perfil sem vínculo e rede indisponível.
- Convites e links de recuperação de homologação, sem credenciais de produção.

### Cenários de regressão

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

### Matriz visual mínima

- Desktop em Chromium e Firefox; Safari quando disponível no ambiente de avaliação.
- Android/Chrome e iOS/Safari para os fluxos móveis, quando houver dispositivos/ambientes disponíveis; registrar qualquer lacuna.
- Larguras de referência: 320, 375, 768 e 1440 px; zoom de 200%; tema claro e escuro quando suportados.
- Login, recuperação, dashboard, menu da conta, inbox, editor e telas principais do disparador.
- Teclado virtual aberto em formulários móveis e foco após fechar modais/gavetas.
- Avaliação automatizada de acessibilidade complementada por execução manual por teclado e leitor de tela.

## 10. Implantação e acompanhamento

- Publicar frontend, middleware e ajustes de sessão de forma coordenada, verificando compatibilidade com os controles do backend.
- Aplicar a limpeza necessária de cookies/tokens legados sem apagar rascunhos válidos do usuário ou dados não relacionados.
- Nas mudanças do editor, validar migração e recuperação de rascunhos eventualmente existentes. Nunca tratar falha de save como autorização para descartar dados.
- Medir loops/redirects repetidos, erros de perfil, falhas de recuperação e salvamento com dados operacionais mínimos; não registrar senhas, tokens, links de recuperação completos ou conteúdo sensível dos fluxos.
- Em regressão de autenticação, preservar autorização e limpeza de estado; não restaurar redirecionamento baseado apenas em cookie inválido como solução.
- Fazer revisão com usuários operacionais em homologação, registrando tarefas concluídas, bloqueios encontrados e ajustes necessários.

## 11. Definição de conclusão

- [ ] UX-01 a UX-08 têm implementação e evidência de validação, ou retirada formal do serviço afetado quando ele estiver descontinuado.
- [ ] Critérios de aceite aplicáveis estão aprovados em homologação.
- [ ] DEC-01 possui decisão registrada e mudanças correspondentes concluídas; se a decisão continuar pendente, o documento não deve declarar esse item concluído.
- [ ] Build, lint, typecheck e testes relevantes dos serviços alterados foram executados e registrados.
- [ ] Navegação por papel e controle de acesso continuam alinhados às regras do backend.
- [ ] Validação visual e de acessibilidade registra navegadores/dispositivos utilizados e lacunas remanescentes.
- [ ] Fluxos de login, logout, recuperação, convites, atendimento e edição não apresentam regressões nos cenários definidos.
- [ ] Cada entrega registra arquivos alterados, critérios validados, limitações e procedimento de implantação.

## 12. Controle de execução

| ID     | Status inicial   | Evidência para encerramento                                         |
| ------ | ---------------- | ------------------------------------------------------------------- |
| UX-01  | Não iniciado     | Testes de 401, cookie remanescente, login inválido e logout         |
| UX-02  | Não iniciado     | Testes de rede, timeout, retry e troca de identidade                |
| UX-03  | Não iniciado     | Fluxos de recuperação, callback inválido e destino após sucesso     |
| UX-04  | Não iniciado     | Matriz de menus por papel e gerenciamento da própria senha          |
| UX-05  | Não iniciado     | Deep links permitidos/proibidos, destino externo e convites         |
| UX-06  | Não iniciado     | Navegação antes do debounce, falha e concorrência de saves          |
| UX-07  | Não iniciado     | Revisão móvel, foco da gaveta, formulários e iframe                 |
| UX-08  | Não iniciado     | Nomes acessíveis, anúncios, idioma e revisão manual/automatizada    |
| DEC-01 | Decisão pendente | Política aprovada, configuração correspondente e testes de cadastro |
