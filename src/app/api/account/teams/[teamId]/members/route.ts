// ============================================================
// /api/account/teams/[teamId]/members
//
//   GET    — list the team's member user_ids.  Any account member.
//   POST   — add a member to the team.         Admin+.
//   DELETE — remove a member from the team.    Admin+.
//
// Backed by wacrm.team_members (migration 062) — a many-to-many
// junction table between agents and teams. RLS on team_members
// (same migration) already restricts SELECT to members of the
// team's account and INSERT/DELETE to owner/admin of that account —
// the explicit team-ownership check below exists so a foreign
// teamId returns a clean 404 instead of a silent empty result or an
// RLS-denied write.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

/** True if `teamId` belongs to `accountId`. Used to 404 early rather
 *  than let a foreign team silently return an empty list / fail RLS. */
async function teamBelongsToAccount(
  supabase: SupabaseClient,
  teamId: string,
  accountId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("teams")
    .select("id")
    .eq("id", teamId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) {
    console.error("[team members] team lookup error:", error);
    return false;
  }
  return !!data;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { teamId } = await params;

    if (!(await teamBelongsToAccount(ctx.supabase, teamId, ctx.accountId))) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const { data, error } = await ctx.supabase
      .from("team_members")
      .select("user_id")
      .eq("team_id", teamId);

    if (error) {
      console.error("[team members] list error:", error);
      return NextResponse.json(
        { error: "Failed to load team members" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      userIds: (data ?? []).map((row) => row.user_id as string),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { teamId } = await params;

    const limit = checkRateLimit(
      `admin:teamMemberAdd:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    if (!(await teamBelongsToAccount(ctx.supabase, teamId, ctx.accountId))) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as
      | { userId?: unknown }
      | null;
    const userId = body?.userId;

    if (typeof userId !== "string" || !userId) {
      return NextResponse.json(
        { error: "'userId' must be a non-empty string" },
        { status: 400 },
      );
    }

    // team_members.user_id references auth.users directly, with no
    // account scoping of its own — this is the only thing stopping an
    // admin from linking a foreign-account user into a local team.
    const { data: targetProfile, error: profileErr } = await ctx.supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (profileErr) {
      console.error("[team members] target lookup error:", profileErr);
      return NextResponse.json(
        { error: "Failed to verify member" },
        { status: 500 },
      );
    }
    if (!targetProfile || targetProfile.account_id !== ctx.accountId) {
      return NextResponse.json(
        { error: "Member not found in this account" },
        { status: 404 },
      );
    }

    const { error } = await ctx.supabase
      .from("team_members")
      .upsert(
        { team_id: teamId, user_id: userId },
        { onConflict: "team_id,user_id", ignoreDuplicates: true },
      );

    if (error) {
      console.error("[team members] insert error:", error);
      return NextResponse.json(
        { error: "Failed to add member to team" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { teamId } = await params;

    const limit = checkRateLimit(
      `admin:teamMemberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    if (!(await teamBelongsToAccount(ctx.supabase, teamId, ctx.accountId))) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as
      | { userId?: unknown }
      | null;
    const userId = body?.userId;

    if (typeof userId !== "string" || !userId) {
      return NextResponse.json(
        { error: "'userId' must be a non-empty string" },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase
      .from("team_members")
      .delete()
      .eq("team_id", teamId)
      .eq("user_id", userId);

    if (error) {
      console.error("[team members] delete error:", error);
      return NextResponse.json(
        { error: "Failed to remove member from team" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
