// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { can } from "@/lib/auth/permissions";
import { isAccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/account/admin-client";
import { loadMembersAccess } from "@/lib/members/member-status";
import type { AccountMember } from "@/types";

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  created_at: string;
  team_id: string | null;
  max_simultaneous_chats: number | null;
  /** Migration 311; ausente antes dela. */
  deactivated_at?: string | null;
}

export async function GET() {
  try {
    const ctx = await requirePermission("members.view");

    // Service role escopado pela conta do chamador (já validada em requirePermission): o cliente do usuário não lê mais
    // profiles.email (migration 306); o e-mail é mascarado abaixo para quem não tem members.view_emails.
    const { data, error } = await supabaseAdmin()
      .from("profiles")
      // "*": inclui deactivated_at (migration 311) sem quebrar enquanto ela não foi aplicada.
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Falha ao carregar os membros" },
        { status: 500 },
      );
    }

    const canSeeEmails = can(ctx, "members.view_emails");
    // Último acesso é dado de gestão: só para quem gere membros (members.manage).
    const canSeeAccess = can(ctx, "members.manage");
    const access = canSeeAccess ? await loadMembersAccess(supabaseAdmin(), ctx.accountId) : new Map();

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          joined_at: row.created_at,
          team_id: row.team_id,
          max_simultaneous_chats: row.max_simultaneous_chats,
          active: !row.deactivated_at,
          deactivated_at: row.deactivated_at ?? null,
          last_sign_in_at: canSeeAccess ? (access.get(row.user_id)?.last_sign_in_at ?? null) : null,
          last_active_at: canSeeAccess ? (access.get(row.user_id)?.last_active_at ?? null) : null,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
