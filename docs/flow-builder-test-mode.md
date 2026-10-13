# Aba Teste — Flow Builder (V1 / main)

O editor em /flows/[id] oferece **Diagrama**, **Lista** e **Teste**. O teste funciona com o estado atual em memória, incluindo edições ainda não salvas e fluxos em rascunho, sem ativar nem alterar execuções reais.

## Como usar

1. Abra um fluxo, configure o nó de entrada e acesse **Teste**.
2. Informe um contato fictício. Para testar condições, podem ser informados tags (IDs), email, empresa e variáveis iniciais JSON.
3. Clique em **Iniciar teste**. O simulador percorre os nós automaticamente até a próxima interação: opções, texto, anexo, resposta de IA simulada ou retorno HTTP simulado.
4. Envie respostas fictícias pela conversa. O painel **Caminho executado** mostra os nós, a decisão tomada e as variáveis/tags locais.
5. Após alterar o fluxo no Diagrama/Lista, volte a Teste e clique em **Reiniciar teste**. Simulações existentes não são silenciosamente continuadas em outro grafo.
6. O teste não verifica o gatilho: começa manualmente no nó de entrada do fluxo.

## Segurança e comportamento

A execução ocorre exclusivamente no navegador, sem chamar a API de execução de fluxos, Supabase, Meta, WAHA, modelos de IA, ferramentas HTTP, canais ou serviços externos. Nenhuma mensagem, tag, nota, transferência ou arquivo é persistido.

- Início, envio de mensagem, botões/listas, coleta de resposta, condições, switch, alteração de variável/tag, âncoras, saltos e fim usam um interpretador em memória.
- Envio de mídia e templates gera prévias descritivas, sem enviar ou consultar Meta.
- Receber anexo aceita apenas um tipo fictício, não um arquivo real.
- Espera inteligente registra o tempo mas avança sem esperar.
- HTTP pausa e exige um JSON fornecido pelo testador; a URL não é chamada.
- Agente de IA pausa e exige a resposta fictícia da IA digitada pelo testador. Modos once, loop (com limite de turnos) e takeover possuem transições simuladas. **Não valida o prompt, o modelo nem a execução das tools.**
- Transferência, salto para outro fluxo e Webchat terminam o trecho local sem realizar ações em outros recursos.
- Nós não suportados, referências quebradas e ciclos sem espera são interrompidos com um erro explícito; há limite de 100 visitas a nós.

A simulação não substitui homologação com provedores reais e não garante que um flow run em produção seguirá os mesmos passos em integrações externas, fallbacks, webhooks ou envio de mídia. Não armazena histórico de testes no servidor. O estado é preservado apenas enquanto a página estiver aberta; alternar entre Diagrama/Lista/Teste não descarta a sessão.

## Verificações automatizadas

Comando: npx vitest run src/lib/flows/test-simulator.test.ts

Os testes cobrem entrada inválida, execução de ponta a ponta, variável interpolada, condição, switch, botões/listas, proteção contra ciclos, limite de turnos do agente, anexo, retorno HTTP fictício, handoff e limites externos.

Não há migrations e nenhuma alteração nos endpoints de execução existentes.
