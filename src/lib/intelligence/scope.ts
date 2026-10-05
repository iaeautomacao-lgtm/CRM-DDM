// Escopo de dados do Intelligence (PRD-04). Vem SEMPRE do contexto
// autenticado (getCurrentAccount) — nunca do input de uma ferramenta nem
// do modelo. Toda consulta de data.ts filtra explicitamente por
// scope.accountId e, quando teamIds != null, pelas equipes.
//
//   owner/admin  → conta toda (teamIds = null)
//   supervisor   → só as equipes de que participa (wacrm.team_members)
//   demais       → sem acesso
//
// `role` é string porque "supervisor" entra no AccountRole em outra
// mudança (migration 139); aqui não dependemos disso.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ForbiddenError } from "@/lib/auth/account";

export interface IntelligenceScope {
  accountId: string;
  userId: string;
  role: string;
  /** null = conta toda. Nunca vazio (supervisor sem equipe é barrado). */
  teamIds: string[] | null;
}

export async function resolveIntelligenceScope(
  ctx: { accountId: string; userId: string; role: string },
  db: SupabaseClient,
): Promise<IntelligenceScope> {
  if (!ctx.accountId || !ctx.userId) throw new ForbiddenError("Contexto de conta inválido");

  if (ctx.role === "owner" || ctx.role === "admin") {
    return { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role, teamIds: null };
  }
  if (ctx.role !== "supervisor") {
    throw new ForbiddenError("O DDM Intelligence é restrito a owner, admin e supervisor");
  }

  const { data: memberships, error } = await db
    .from("team_members")
    .select("team_id")
    .eq("user_id", ctx.userId)
    .order("team_id")
    .range(0, 499);
  if (error) throw new Error(`Falha ao carregar equipes do supervisor: ${error.message}`);
  const candidate = [...new Set((memberships ?? []).map((m) => (m as { team_id: string }).team_id))];
  if (candidate.length === 0) throw new ForbiddenError("Supervisor sem equipe");

  // team_members não tem account_id: confirma que as equipes são desta conta.
  const { data: teams, error: teamsErr } = await db
    .from("teams")
    .select("id")
    .eq("account_id", ctx.accountId)
    .in("id", candidate)
    .order("id")
    .range(0, 499);
  if (teamsErr) throw new Error(`Falha ao validar equipes do supervisor: ${teamsErr.message}`);
  const teamIds = (teams ?? []).map((t) => (t as { id: string }).id).sort();
  if (teamIds.length === 0) throw new ForbiddenError("Supervisor sem equipe");

  return { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role, teamIds };
}

/**
 * Filtro opcional por uma equipe DENTRO do escopo. Supervisor só pode
 * pedir equipe dele; para owner/admin o account_id continua no filtro,
 * então equipe de outra conta só devolve vazio.
 */
export function narrowScopeToTeam(scope: IntelligenceScope, teamId: string | undefined): IntelligenceScope {
  if (!teamId) return scope;
  if (scope.teamIds !== null && !scope.teamIds.includes(teamId)) {
    throw new ForbiddenError("Equipe fora do seu escopo");
  }
  return { ...scope, teamIds: [teamId] };
}

/** Rótulo do escopo para a resposta da API. */
export function describeScope(scope: IntelligenceScope): { teams: number | "conta" } {
  return { teams: scope.teamIds === null ? "conta" : scope.teamIds.length };
}
