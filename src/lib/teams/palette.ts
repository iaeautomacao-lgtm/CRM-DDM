// Paleta FECHADA de cores de equipe (PRD 23, item 12). A migration 280 tem o MESMO conjunto num CHECK em teams.color: o banco recusa
// qualquer outra cor (o cadastro de equipe grava direto pela API do Supabase), e o teste palette.test.ts garante que as duas listas não divergem.
export const TEAM_COLORS = [
  '#ef4444', // vermelho
  '#f97316', // laranja
  '#eab308', // amarelo
  '#22c55e', // verde
  '#14b8a6', // turquesa
  '#3b82f6', // azul
  '#6366f1', // índigo
  '#a855f7', // roxo
  '#ec4899', // rosa
  '#64748b', // cinza
] as const

export type TeamColor = (typeof TEAM_COLORS)[number]

/** true se `value` é uma cor da paleta (hex em minúsculas, igual ao CHECK do banco). */
export function isTeamColor(value: unknown): value is TeamColor {
  return typeof value === 'string' && (TEAM_COLORS as readonly string[]).includes(value)
}
