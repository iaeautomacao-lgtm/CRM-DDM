// Paginação keyset (`id > cursor ORDER BY id LIMIT n`) para leituras de
// tabelas grandes (contacts, blacklist, disp_message_queue, …).
//
// `.range()` (OFFSET) relê e descarta tudo antes da página: o custo total
// cresce com o quadrado do volume (B9 do PRD 08) e, sem ORDER BY estável,
// pode pular ou repetir linhas entre páginas. Aqui cada página começa no
// último id lido — custo constante por página, sem pular nem duplicar.
//
// A query de cada página DEVE selecionar `id` e ordenar por `id` crescente;
// `afterId` é null na primeira página.

export const KEYSET_PAGE = 1000;

export type KeysetPageResult<Row> = PromiseLike<{
  data: Row[] | null;
  error: { message: string } | null;
}>;

export async function fetchAllKeyset<Row extends { id: string | number }>(
  label: string,
  fetchPage: (afterId: string | number | null, limit: number) => KeysetPageResult<Row>,
  pageSize: number = KEYSET_PAGE,
): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | number | null = null;
  while (true) {
    const { data, error } = await fetchPage(after, pageSize);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1].id;
  }
  return out;
}
