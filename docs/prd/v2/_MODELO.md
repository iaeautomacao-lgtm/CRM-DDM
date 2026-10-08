# Modelo de PRD — V2 backend do CRM-DDM

Regras: português; **só backend** (o frontend é de outra pessoa — mas cada PRD traz o **contrato de API** que o front vai consumir); tudo verificado no código atual da branch `v2` (`git fetch origin && git checkout origin/v2` num worktree), com **arquivo:linha**; nada inventado — o que não der para confirmar vira "A confirmar no live" ou pergunta ao dono. Nada de "fazer depois" vago: todo item tem severidade, critério de aceite e dono provável (BE/OPS).
Restrições do projeto (CLAUDE.md e decisões): bifurcação Meta×WAHA nunca unificada; migrations manuais no SQL Editor, idempotentes, com pré-check, `CREATE INDEX CONCURRENTLY` sozinho; Passenger = sem worker em memória no app (worker só como serviço separado no EasyPanel); não mexer na truncagem do engine nem em `hasRunLeftNodeSnapshot`; opt-out obrigatório; `limite_por_hora` não muda sem o dono; **retenção de dados está FORA**.

## Estrutura (use estes títulos)
1. **Resumo** (5 linhas: problema, objetivo, ganho)
2. **Estado atual** (como funciona hoje, com arquivo:linha; números medidos quando houver)
3. **Problemas e riscos** — tabela: ID | severidade (CRÍTICA/ALTA/MÉDIA/BAIXA) | onde (arquivo:linha) | problema | cenário de falha | correção
4. **Objetivos e não-objetivos**
5. **Requisitos** — funcionais e não funcionais (desempenho com números, segurança, observabilidade), cada um com critério de aceite testável
6. **Desenho proposto** (componentes, fluxo, decisões e alternativas descartadas)
7. **Dados e migrations** (tabelas/colunas/índices/RPCs; ordem; pré-check; rollback)
8. **Contrato para o frontend** (rotas, payloads, erros, permissões — o que a pessoa do front precisa)
9. **Testes e aceite** (unit, PGlite, bancada de carga, staging; o que prova que está "blindado")
10. **Observabilidade** (logs/eventos/métricas/alertas)
11. **Riscos, rollback e plano de implantação** (flags, degraus, ordem)
12. **Fases e PRs** (lista de PRs pequenos, ordem, dependências, estimativa P/M/G)
13. **Perguntas ao dono**

## REGRA DO DONO (08/10): não mexer em NEGÓCIO
Prompt, textos da IA (inclui fallback "Ben"), personas, quando encerrar conversa, como tratar ofensa, quando/como propor ou efetivar acordo, régua/mensagens de cobrança: **não são escopo técnico**. Nos PRDs, esses itens aparecem só como **"Decisão da operação"** (descrever o risco técnico e parar) — sem requisito de mudança de comportamento e sem PR. O escopo é lógica e código: robustez, desempenho, segurança, observabilidade, bugs técnicos, contratos de API.
