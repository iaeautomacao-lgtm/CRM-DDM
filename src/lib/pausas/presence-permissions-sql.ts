// Só para os testes de SQL de papéis/catálogo (roles-foundation, custom-roles, roles-by-level): o catálogo do código já tem as permissões
// de pausa (presence.*), então o seed do banco nos testes precisa tê-las. A migration 370 também cria tabelas (que esses testes não montam),
// então aqui sai só a seção "1. Permissões" dela (catálogo + papéis de sistema), que depende apenas de permission_catalog/role_permissions/account_roles.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const START = '-- ---------- 1. Permissões'
const END = '-- ---------- 2. Motivos'

export function presencePermissionsFrom370(): string {
  const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/370_pausas_atendimento.sql'), 'utf8')
  const from = sql.indexOf(START)
  const to = sql.indexOf(END)
  if (from < 0 || to < from) throw new Error('370: seções "1. Permissões"/"2. Motivos" não encontradas (o helper de teste depende desses marcadores)')
  return sql.slice(from, to)
}
