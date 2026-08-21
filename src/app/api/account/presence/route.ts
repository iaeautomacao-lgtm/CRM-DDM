import { NextRequest, NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import type { StoredPresence } from "@/lib/presence";

export async function POST(req: NextRequest) {
  try {
    const ctx = await getCurrentAccount();

    let status: StoredPresence = "online";
    try {
      const body = (await req.json()) as { status?: unknown };
      if (body?.status === "online" || body?.status === "away") {
        status = body.status;
      }
    } catch {
      // No/invalid JSON body — keep the "online" default.
    }

    const { error } = await ctx.supabase.rpc("touch_presence", {
      p_status: status,
    });
    if (error) {
      console.error("[account/presence] touch_presence error:", error);
      return NextResponse.json(
        { error: "Failed to update presence" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
