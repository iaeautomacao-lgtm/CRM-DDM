// Escape ÚNICO para valores embutidos em filtros `.or()` do PostgREST (revisão de segurança 13/10, item 24).
//
// O `.or("a.ilike.X,b.ilike.X")` do supabase-js recebe uma STRING com gramática própria: `,` separa filtros, `(` `)` agrupam, `.` separa operador,
// `"` abre valor entre aspas e `\` escapa dentro dele. Termo digitado pelo usuário colado direto nessa string pode fechar o filtro e acrescentar outro
// (ex.: `x,id.gt.0`) — sempre dentro da própria conta (RLS + .eq('account_id')), mas muda o resultado. Cada tela escapava do seu jeito (tirando
// `%` e `,`, ou nada). Aqui fica UMA regra:
//   1. `pgrstQuote`  — valor entre aspas, com `\` e `"` escapados: nenhum caractere do usuário sai do valor;
//   2. `escapeLike`  — `%`, `_` e `\` do termo viram literais para o LIKE/ILIKE (quem digita "50%" procura "50%", não "50" + qualquer coisa);
//   3. `orIlikeContains` — junta os dois: `col1.ilike."%termo%",col2.ilike."%termo%"`.

/** Valor de filtro entre aspas duplas (`"` e `\` escapados com `\`). */
export function pgrstQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Torna `%`, `_` e `\` do termo literais num LIKE/ILIKE (o padrão de escape do Postgres é a barra invertida). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `col.ilike."%termo%"` para cada coluna, separados por vírgula — pronto para `.or(...)`. Termo vazio devolve string vazia. */
export function orIlikeContains(columns: readonly string[], term: string): string {
  const trimmed = term.trim();
  if (!trimmed) return "";
  const pattern = pgrstQuote(`%${escapeLike(trimmed)}%`);
  return columns.map((c) => `${c}.ilike.${pattern}`).join(",");
}
