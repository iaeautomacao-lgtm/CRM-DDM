import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// Leitura de wacrm.whatsapp_config COM segredos (access_token, app_secret,
// verify_token, waha_api_key) para rotas que usam o cliente de SESSÃO.
//
// Migration 200b: o papel `authenticated` não tem mais SELECT nas colunas de
// segredo — um membro (inclusive viewer) não pode ler o token do canal direto
// pelo PostgREST. As rotas do servidor continuam precisando do segredo para
// enviar mensagens, falar com a Meta/WAHA etc., mas SEM perder a regra de
// visibilidade que a RLS dava (agente/supervisor só veem os canais da equipe,
// migrations 103/140). Por isso a leitura é em duas etapas:
//   1. cliente de sessão, colunas NÃO secretas (só `id`): a RLS decide quais
//      linhas o usuário enxerga — os filtros/ordem/limite da rota valem aqui;
//   2. service role, filtrado por `account_id` E pelos ids da etapa 1: devolve
//      as colunas pedidas (inclusive segredos), na mesma ordem.
// Só o servidor chama; nunca devolva a linha crua ao navegador.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Filter = (query: any) => any
type DbError = { message: string; code?: string } | null

export interface ChannelConfigResult<Row> {
  data: Row[] | null
  error: DbError
}

export async function fetchChannelConfigs<Row = Record<string, any>>(
  session: SupabaseClient,
  accountId: string,
  filter: Filter = (q) => q,
  columns = '*',
): Promise<ChannelConfigResult<Row>> {
  const visible = await filter(session.from('whatsapp_config').select('id'))
  if (visible.error) return { data: null, error: visible.error }

  const ids: string[] = ((visible.data ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) return { data: [], error: null }

  const full = await supabaseAdmin()
    .from('whatsapp_config')
    .select(columns)
    .eq('account_id', accountId)
    .in('id', ids)
  if (full.error) return { data: null, error: full.error }

  const rows = ((full.data ?? []) as unknown as Array<Record<string, any>>)
  const byId = new Map(rows.map((r) => [r.id as string, r]))
  // Mantém a ordem da etapa 1 (a rota pode ter pedido .order()).
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is Record<string, any> => !!r)
  return { data: ordered as Row[], error: null }
}

/** Primeira linha visível (equivale a `.limit(1)` + `.maybeSingle()`). */
export async function fetchChannelConfig<Row = Record<string, any>>(
  session: SupabaseClient,
  accountId: string,
  filter: Filter = (q) => q,
  columns = '*',
): Promise<{ data: Row | null; error: DbError }> {
  const res = await fetchChannelConfigs<Row>(session, accountId, (q) => filter(q).limit(1), columns)
  return { data: res.data?.[0] ?? null, error: res.error }
}
