# Exportação segura (PRD 14, 14.6 — SG-17 e SG-18)

## 1. CSV/planilha sem fórmula (SG-18)

Uma célula de texto que começa com `=`, `+`, `-`, `@`, TAB ou CR é lida como **fórmula** pela planilha. Dado vindo de fora
(nome de perfil do WhatsApp, variável de CSV importado, texto de mensagem) chega ao arquivo exportado: um contato chamado
`=HYPERLINK("http://x","clique")` viraria link na planilha de um supervisor.

**Helper único:** `src/lib/security/csv-safe.ts` (puro; serve ao servidor e ao navegador).

| Função | Uso |
|---|---|
| `neutralizeFormula(texto)` / `safeCell(valor)` | uma célula; só **texto** é alterado (prefixo `'`); número, booleano, Date e vazio passam |
| `safeRows(linhas)` / `safeRow(linha)` | linhas de objetos para `XLSX.utils.json_to_sheet(safeRows(linhas))` |
| `csvCell(valor)` | célula de CSV montado à mão (neutraliza **e** escapa aspas, `;` e quebras de linha) |
| `csvSafe(valor)` | só neutraliza, devolvendo texto (sem escapar) |
| `csvLine(valores, sep = ";")` | linha de CSV: `csvCell` em cada valor, juntos por `sep` |

Este é o **único** módulo de CSV seguro do projeto (`src/lib/security/csv-safe.ts`); a exportação assíncrona do disparador
(`lib/disparador/export-jobs.ts`) importa daqui em vez de ter cópia própria.

**Regra:** todo código que gera CSV/XLSX passa as células pelo helper. O teste `src/lib/security/csv-safe.test.ts`
varre `src/` e **falha** se um arquivo gera planilha (`json_to_sheet`/`aoa_to_sheet`/`sheet_add_*`) ou responde `text/csv` sem
importar o helper (exceções documentadas no próprio teste). **Exportações novas — inclusive a exportação assíncrona do
disparador (`relatorios/exports`, migration 203) — devem gerar o arquivo com estes helpers.**

Pontos que geram arquivo hoje (todos cobertos):

| Ponto | Onde roda | Como |
|---|---|---|
| Relatórios: conversas, envio em lote, tabulações (+ histórico) | **navegador** (`lib/relatorios/export-with-history.ts`) | `safeRows` — vale para o arquivo baixado **e** para o que vai ao histórico |
| Auditoria (`/api/audit-logs?export=…`) | servidor | `safeRows` |
| Detalhamento de campanha (`queue-details`) | servidor | `safeRows` |
| Erros do disparador (CSV) | servidor | `csvCell` (via `errosToCsv`) |

Não gera célula de dado: `relatorios/exports/route.ts` só grava o arquivo já pronto (vindo do navegador) no Storage.

## 2. Quem lê a exportação (SG-17) — migration 220

Gerar e listar exportações exige `reports.export` (supervisor+), mas `export_history` e o Storage do bucket
`relatorio-exports` estavam abertos a **qualquer membro**. A migration **220** alinha as três portas à mesma permissão
(`wacrm.has_perm('reports.export')`, da 241): policy de `export_history`, policy do Storage (`supervisors read exports`) e a
RPC `get_export_history` (vazia, sem `storage_path`, para quem não tem a permissão). Supervisor, admin e proprietário não mudam.

## 3. O que ainda NÃO está no servidor (para a exportação assíncrona / fase de RLS)

Os três relatórios acima ainda **montam o arquivo no navegador** com o que a RLS deixa o usuário ler; o servidor só recebe o
arquivo pronto. Mover a geração para o servidor depende da exportação assíncrona do disparador (migration 203,
`relatorios/exports`) — que passa a ser o único ponto de geração — e do fechamento das RPCs de relatório que hoje só exigem
"ser membro" (P-05, PRD 20, fase 20.7). Enquanto isso, a neutralização acontece **no navegador antes de o arquivo existir**, então o
arquivo enviado ao histórico já sai seguro.
