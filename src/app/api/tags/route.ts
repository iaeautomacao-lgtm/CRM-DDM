import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

/**
 * GET /api/tags
 *
 * Lists the caller's account tags — used by the Flow Builder's
 * `condition` (subject=tag) and `set_tag` forms so they can show tag
 * names instead of raw UUIDs (see useUserTags() in
 * src/components/flows/forms/node-config-form.tsx, which already
 * tolerates this endpoint being absent and falls back to a raw UUID
 * input — this route existing just upgrades that UX, it doesn't
 * change what's required for those forms to work).
 *
 * Available to any account member (matches `tags_select`'s RLS
 * policy from migration 017 — read is open, write is admin+).
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from("tags")
      .select("id, name, color")
      .eq("account_id", ctx.accountId)
      .order("name");

    if (error) {
      console.error("[tags] list error:", error);
      return NextResponse.json(
        { error: "Failed to load tags" },
        { status: 500 },
      );
    }

    return NextResponse.json({ tags: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
