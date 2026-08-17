// ============================================================
// POST /api/account/members/[userId]/reset-password
//
// Owner-only. Resets a teammate's password directly via the
// Supabase Admin API — there's no self-serve "forgot password" flow
// for members the owner manages by hand, so this is the escape
// hatch when someone is locked out or a shared login needs rotating.
//
// Unlike PATCH/DELETE on this same resource, there is no SECURITY
// DEFINER RPC backing this call — auth.admin.updateUserById() runs
// with the service role and bypasses RLS entirely. That means THIS
// route is the only thing standing between "owner resets a
// teammate's password" and "owner resets any user's password in the
// whole Supabase project." The account-membership check below is
// load-bearing, not defensive fluff.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/account/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const MIN_PASSWORD_LENGTH = 8;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("owner");

    const limit = checkRateLimit(
      `admin:resetMemberPassword:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    // Changing your own password belongs in the profile/settings
    // flow, not this admin action — also closes off any weirdness
    // from an owner resetting their own session mid-request.
    if (userId === ctx.userId) {
      return NextResponse.json(
        { error: "Use suas próprias configurações de perfil para trocar sua senha" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { password?: unknown }
      | null;
    const password = body?.password;

    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        {
          error: `'password' must be a string with at least ${MIN_PASSWORD_LENGTH} characters`,
        },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();

    // Confirm the target is actually a member of the caller's account
    // before touching auth.users — see file header.
    const { data: targetProfile, error: profileErr } = await admin
      .from("profiles")
      .select("account_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (profileErr) {
      console.error("[reset-password] profile lookup error:", profileErr);
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

    const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
      password,
    });

    if (updateErr) {
      console.error("[reset-password] updateUserById error:", updateErr);
      return NextResponse.json(
        { error: updateErr.message || "Failed to reset password" },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
