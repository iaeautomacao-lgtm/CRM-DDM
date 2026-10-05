// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role and/or handoff capacity. Admin+.
//   DELETE — remove a member.                                 Admin+.
//
// PATCH accepts `role`, `max_simultaneous_chats`, or both in the same
// body; each field present is applied independently via its own RPC.
//
// These delegate to SECURITY DEFINER RPCs:
//   - set_member_role(p_user_id, p_new_role)                  (migration 018)
//   - set_member_max_simultaneous_chats(p_user_id, p_max)      (migration 116)
//   - remove_account_member(p_user_id)                         (migration 018)
//
// The RPCs do the *real* authorisation work — caller must be
// admin+, target must be in caller's account, target can't be the
// owner, can't be self. The TS layer here only forwards the call
// and maps Postgres SQLSTATEs back to HTTP statuses.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

// Map known SQLSTATEs from the RPCs (see migration 018) onto HTTP
// statuses. The `error.code` field is the SQLSTATE; the `message`
// is the human-readable RAISE message we put in the migration.
function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[members route] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown; max_simultaneous_chats?: unknown }
      | null;
    const hasRole = body != null && "role" in body;
    const hasMaxChats = body != null && "max_simultaneous_chats" in body;

    if (!hasRole && !hasMaxChats) {
      return NextResponse.json(
        { error: "Provide 'role' and/or 'max_simultaneous_chats' to update" },
        { status: 400 },
      );
    }

    if (hasRole) {
      const role = body!.role;

      if (!isAccountRole(role)) {
        return NextResponse.json(
          { error: "'role' must be one of owner, admin, supervisor, agent, viewer" },
          { status: 400 },
        );
      }

      // The RPC blocks promotion to / demotion from owner, but
      // surface the friendlier 400 before crossing the wire too.
      if (role === "owner") {
        return NextResponse.json(
          {
            error:
              "Use POST /api/account/transfer-ownership to promote a member to owner",
          },
          { status: 400 },
        );
      }

      const { error } = await ctx.supabase.rpc("set_member_role", {
        p_user_id: userId,
        p_new_role: role,
      });

      if (error) return rpcErrorToResponse(error);
    }

    if (hasMaxChats) {
      const maxChats = body!.max_simultaneous_chats;

      if (
        maxChats !== null &&
        (typeof maxChats !== "number" || !Number.isInteger(maxChats) || maxChats < 1)
      ) {
        return NextResponse.json(
          { error: "'max_simultaneous_chats' must be an integer >= 1, or null" },
          { status: 400 },
        );
      }

      const { error } = await ctx.supabase.rpc(
        "set_member_max_simultaneous_chats",
        { p_user_id: userId, p_max: maxChats },
      );

      if (error) return rpcErrorToResponse(error);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const { data, error } = await ctx.supabase.rpc("remove_account_member", {
      p_user_id: userId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true, newPersonalAccountId: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
