import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { parseInboxFilters, sanitizeSearch } from '@/lib/inbox/filters'
import { applyInboxFilters, resolveLineClause } from '@/lib/inbox/query'

// GET /api/inbox/conversations — lista do inbox paginada no servidor.
//
// Filtros (?canal=&linha=&atendente=&equipe=&cliente=&campanha=&status=&q=)
// em src/lib/inbox/filters.ts. Paginação por cursor (last_message_at, id),
// 50 por página. Usa o cliente com a sessão do usuário: a RLS de
// conversations (migration 128) já limita o agente às atribuídas a ele e
// à fila da equipe — a rota não reimplementa permissão.

const PAGE_SIZE = 50
const SELECT = '*, contact:contacts(*), outcome_tag:tags!outcome_tag_id(*)'
// Busca por nome/telefone filtra pelo contato: precisa do join !inner.
const SELECT_WITH_SEARCH = '*, contact:contacts!inner(*), outcome_tag:tags!outcome_tag_id(*)'

export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    const params = new URL(request.url).searchParams
    const filters = parseInboxFilters(params)
    const search = sanitizeSearch(filters.q)
    const line = await resolveLineClause(supabase, accountId, filters.linha)

    let query = applyInboxFilters(
      supabase
        .from('conversations')
        .select(search ? SELECT_WITH_SEARCH : SELECT)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(PAGE_SIZE + 1),
      filters,
      { accountId, userId, line },
      { includeStatus: true }
    )
    if (search) {
      query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`, { referencedTable: 'contacts' })
    }

    // Cursor "last_message_at|id" da última linha da página anterior
    // ("null|id" quando ela não tinha mensagem — nulos vêm por último).
    const cursor = params.get('cursor')
    if (cursor) {
      const [at, id] = cursor.split('|')
      if (id && /^[0-9a-f-]{36}$/i.test(id)) {
        if (at === 'null') {
          query = query.is('last_message_at', null).lt('id', id)
        } else if (at && !Number.isNaN(Date.parse(at))) {
          query = query.or(
            `last_message_at.lt.${at},and(last_message_at.eq.${at},id.lt.${id}),last_message_at.is.null`
          )
        }
      }
    }

    const { data, error } = await query
    if (error) throw error
    const rows = (data ?? []) as Array<{ id: string; last_message_at: string | null }>
    const hasMore = rows.length > PAGE_SIZE
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows
    const last = page[page.length - 1]
    return NextResponse.json({
      conversations: page,
      next_cursor: hasMore && last ? `${last.last_message_at ?? 'null'}|${last.id}` : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
