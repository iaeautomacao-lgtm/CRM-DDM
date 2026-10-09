import { NextResponse } from "next/server";
import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getOrCreateVapidPublicKey, PushUnavailableError } from "@/lib/push/service";

export const dynamic = "force-dynamic";

// GET /api/push/vapid-key → { public_key } (applicationServerKey, base64url) da conta. A plataforma gera o par na 1ª chamada; a privada
// fica cifrada em tabela fechada e nunca sai do servidor. Qualquer membro com acesso ao Inbox (TASK36 item 3).
export async function GET() {
  try {
    const ctx = await requirePermission("inbox.view");
    return NextResponse.json({ public_key: await getOrCreateVapidPublicKey(supabaseAdmin(), ctx.accountId) });
  } catch (err) {
    if (err instanceof PushUnavailableError) return NextResponse.json({ error: err.message, code: "unavailable" }, { status: 503 });
    return toErrorResponse(err);
  }
}
