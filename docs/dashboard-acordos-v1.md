# Dashboard V1 — Acordos registrados (tabulação 142)

## Fonte de verdade

A tabulação atual da conversa em wacrm.conversations.outcome_tag_id, apontando para wacrm.tags com kind=outcome e codigo_tabulacao=142 (Acordo Realizado), define um acordo registrado.

O funil wacrm.deals é independente: pode haver conversas com acordo registrado mesmo quando os deals têm status open e valor zero. Uma conversa conta uma única vez.

## Indicadores

- Total: conversas atualmente tabuladas como Acordo Realizado.
- Registrados pela IA: a última mudança auditada para a tabulação atual tem actor_type=ai.
- Registrados por humanos: a última mudança auditada para a tabulação atual tem actor_type=user.
- Origem não identificada: auditoria ausente, ator inesperado ou mudança não comprovada. Não presumir origem por agente atribuído ou quem encerrou a conversa.
- Participação da IA: ai / (ai + human), excluindo a origem não identificada.
- Cobertura: (ai + human) / total.
- Hoje / 7 / 30 dias: conversas com essa tabulação atual e closed_at no período. Hoje no fuso de Brasília; 7/30 dias móveis.

A origem da auditoria identifica quem registrou a tabulação, NÃO prova quem conduziu a negociação nem que houve pagamento. A classificação automática da IA pode registrar uma negociação conduzida pelo operador, e o operador pode fechar uma conversa atendida pelo bot. Métricas de negociação realmente concluída por IA exigem instrumentação adicional.

O card antigo Acordos ganhos (total) do funil foi renomeado Negócios ganhos (funil). Seu valor financeiro continua dependendo de deals e não é derivado da tabulação 142.

## Segurança e implementação

A rota GET /api/dashboard/agreements exige sessão autenticada e usa o account_id do servidor. Consultas ao Supabase com service_role são explicitamente restritas à conta autenticada e não retornam dados pessoais; a resposta inclui apenas contagens agregadas. Cache: private, no-store.

O carregador pagina conversas e auditorias para não truncar as métricas no limite padrão de 1000 linhas do PostgREST. Acima de 50.000 acordos devolve erro, em vez de um total parcialmente errado; nesse porte deve-se substituir por agregação no PostgreSQL.

O Dashboard carrega a seção de acordos independentemente dos demais widgets. Não há migration nem alterações em escrita ou no motor da IA.

## Validação

Execute: npx vitest run src/lib/dashboard/agreement-metrics.test.ts src/app/api/dashboard/agreements/route.test.ts

Conferir: total = IA + humano + não identificado, origem desconhecida quando não houver auditoria, contagem uma vez por conversa e a janela em Brasília.

Para números estritos de autoria da negociação, criar futuramente um campo/evento de fechamento assinado pelo runtime ou usuário, com auditoria e transição explícita.
