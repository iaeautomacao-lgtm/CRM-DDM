// ============================================================
// POST /api/invitations/redeem-by-code
//
// Authenticated. Same redemption as /api/invitations/[token]/redeem —
// same `redeem_invitation` RPC, same account move, same orphan-account
// cleanup — just keyed by a short human-typeable code instead of a
// link token. The RPC only ever sees a token_hash; it has no idea
// (and doesn't need to know) which entry point produced it.
//
// Body: { code: string }
//
// Refusal contract (from the RPC, via the shared rpcErrorToResponse):
//   - 42501 → 401 (caller not authenticated)
//   - 22023 → 400 (no invitation matches this code, or it's expired —
//     the RPC can't distinguish "wrong code" from "right code, but
//     used/expired" without leaking which codes exist, so both read
//     as the same generic "not found")
//   - 23505 → 409 (caller's account already has data / they're
//     already in this or another shared account)
//
// Rate limit: far tighter than the link's (see
// RATE_LIMITS.invitationRedeemByCode) and keyed by user id, not IP —
// a short code has much less entropy than a link token, so bounding
// the guess rate matters more here than for the link path.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken, normalizeInviteCode } from "@/lib/auth/invitations";
import { rpcErrorToResponse } from "@/lib/auth/invitation-errors";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Keyed by user id — see the budget's doc comment for why this beats
  // an IP key for a guessable-length secret.
  const limit = checkRateLimit(
    `invite-code-redeem:${user.id}`,
    RATE_LIMITS.invitationRedeemByCode,
  );
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await request.json().catch(() => null)) as
    | { code?: unknown }
    | null;

  if (typeof body?.code !== "string" || !body.code.trim()) {
    return NextResponse.json({ error: "Missing invitation code" }, { status: 400 });
  }

  const normalized = normalizeInviteCode(body.code);
  // Cheap early exit for obviously-malformed input — still counted
  // against the rate limit above (a malformed guess is still a guess).
  if (!normalized) {
    return NextResponse.json({ error: "Invalid invitation code" }, { status: 400 });
  }

  const { data: accountId, error } = await supabase.rpc("redeem_invitation", {
    p_token_hash: hashInviteToken(normalized),
  });

  if (error) return rpcErrorToResponse(error);

  return NextResponse.json({ ok: true, accountId });
}
