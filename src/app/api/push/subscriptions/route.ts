import { NextResponse } from "next/server";
import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { deleteSubscription, parseSubscription, PushUnavailableError, saveSubscription } from "@/lib/push/service";

export const dynamic = "force-dynamic";

// POST   /api/push/subscriptions  PushSubscription.toJSON() ({ endpoint, keys: { p256dh, auth } }) → 200 { ok: true }
// DELETE /api/push/subscriptions  { endpoint }                                                      → 200 { ok: true }
// Cada usuário gerencia só as próprias inscrições. O endpoint precisa ser de um serviço de push conhecido (FCM, Mozilla, Apple, WNS).
export async function POST(request: Request) {
  try {
    const ctx = await requirePermission("inbox.view");
    const sub = parseSubscription(await request.json().catch(() => null));
    if (!sub) return NextResponse.json({ error: "Inscrição inválida." }, { status: 400 });
    await saveSubscription(supabaseAdmin(), { accountId: ctx.accountId, userId: ctx.userId, sub, userAgent: request.headers.get("user-agent") });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PushUnavailableError) return NextResponse.json({ error: err.message, code: "unavailable" }, { status: 503 });
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requirePermission("inbox.view");
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    if (!endpoint || endpoint.length > 2048) return NextResponse.json({ error: "Informe o endpoint." }, { status: 400 });
    await deleteSubscription(supabaseAdmin(), { accountId: ctx.accountId, userId: ctx.userId, endpoint });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PushUnavailableError) return NextResponse.json({ error: err.message, code: "unavailable" }, { status: 503 });
    return toErrorResponse(err);
  }
}
