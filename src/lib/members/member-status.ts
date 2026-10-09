import "server-only";
// TASK3 — desativar/reativar membro e último acesso (migration 311). Servidor, service role, sempre escopado pela conta.
//
// Desativar = três camadas: (1) wacrm.set_member_active marca o perfil, apaga as sessões (refresh tokens caem) e tira a
// presença; (2) banimento no Supabase Auth (sem novo login nem renovação de token); (3) getCurrentAccount recusa o perfil
// desativado (403 member_deactivated) durante o tempo que o access token ainda vale (até ~1 h). Reativar desfaz 1 e 2.

import type { SupabaseClient } from "@supabase/supabase-js";

import { logAuditEvent } from "@/lib/audit/log-event";

type Db = Pick<SupabaseClient, "rpc">;
type AuthAdmin = { auth: { admin: { updateUserById: (id: string, attrs: { ban_duration: string }) => Promise<{ error: { message: string } | null }> } } };

/** Banimento "sem prazo" do Supabase Auth (~100 anos); "none" remove. */
export const BAN_FOREVER = "876000h";

export class MemberStatusError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 500,
  ) {
    super(message);
  }
}

export interface MemberStatusResult {
  was_active: boolean;
  is_active: boolean;
  role: string;
  sessions_revoked: number;
  /** O banimento no Supabase Auth falhou: o bloqueio segue pelo perfil e pelas sessões apagadas. */
  ban_failed?: boolean;
}

function mapRpcError(err: { code?: string; message?: string }): MemberStatusError {
  if (err.code === "42501") return new MemberStatusError(err.message ?? "Operação não permitida.", 403);
  if (err.code === "P0002") return new MemberStatusError("Membro não encontrado nesta organização.", 404);
  if (err.code === "22023") return new MemberStatusError("Dados inválidos.", 400);
  if (err.code === "42883" || err.code === "PGRST202") return new MemberStatusError("Desativar membro indisponível: aplique a migration 311.", 500);
  return new MemberStatusError("Não foi possível alterar o membro.", 500);
}

export async function setMemberActive(
  deps: { db: Db; auth: AuthAdmin },
  input: { accountId: string; actorId: string; targetId: string; active: boolean },
): Promise<MemberStatusResult> {
  const { data, error } = await deps.db.rpc("set_member_active", {
    p_account: input.accountId,
    p_actor: input.actorId,
    p_target: input.targetId,
    p_active: input.active,
  });
  if (error) throw mapRpcError(error);
  const result = data as MemberStatusResult;

  const { error: banError } = await deps.auth.auth.admin.updateUserById(input.targetId, {
    ban_duration: input.active ? "none" : BAN_FOREVER,
  });
  if (banError) {
    console.error("[members] falha ao (des)banir no Supabase Auth:", banError.message);
    result.ban_failed = true;
  }

  if (result.was_active !== result.is_active) {
    await logAuditEvent({
      accountId: input.accountId,
      eventType: "updated",
      resourceType: "member",
      resourceId: input.targetId,
      action: input.active ? "member.reactivated" : "member.deactivated",
      summary: input.active ? "Membro reativado" : "Membro desativado",
      metadata: { role: result.role, sessions_revoked: result.sessions_revoked, ...(result.ban_failed ? { ban_failed: true } : {}) },
    });
  }
  return result;
}

export interface MemberAccess {
  last_sign_in_at: string | null;
  last_active_at: string | null;
}

/** Último login e última atividade por membro. Sem a migration 311: mapa vazio (a lista segue sem a coluna). */
export async function loadMembersAccess(db: Db, accountId: string): Promise<Map<string, MemberAccess>> {
  const out = new Map<string, MemberAccess>();
  const { data, error } = await db.rpc("account_members_access", { p_account: accountId });
  if (error) {
    console.warn("[members] último acesso indisponível:", error.code ?? error.message);
    return out;
  }
  for (const row of (data ?? []) as Array<{ user_id: string; last_sign_in_at: string | null; last_active_at: string | null }>) {
    out.set(row.user_id, { last_sign_in_at: row.last_sign_in_at, last_active_at: row.last_active_at });
  }
  return out;
}
