// ============================================================
// Shared `redeem_invitation` RPC error → HTTP mapping.
//
// Both redeem entry points (by link token, by short code) call the
// exact same SECURITY DEFINER RPC (migration 019, fixed by 048) and
// therefore see the exact same SQLSTATEs back — this is the one place
// that maps them to HTTP, so the two routes can't drift.
//
//   42501 → 401 (caller not authenticated)
//   22023 → 400 (invitation not_found / used / expired — or, for the
//           code entry point, "no invitation matches this code")
//   23505 → 409 (caller's account already has data / they're already
//           in this or another shared account)
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

export function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err.code === "23505") {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  console.error("[redeem_invitation] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to redeem invitation" },
    { status: 500 },
  );
}
