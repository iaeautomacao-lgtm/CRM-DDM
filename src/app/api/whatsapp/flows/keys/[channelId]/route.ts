// ============================================================
// /api/whatsapp/flows/keys/{channelId} — par RSA do Data Exchange dos WhatsApp Flows (PRD 21, PR 21.2; migration 291).
//
//   GET   channels.view    { configured, public_key, created_at, rotated_at } — SÓ a pública; a privada nunca sai do servidor.
//   POST  channels.manage  gera o par (idempotente: se já existe, devolve a pública). Corpo opcional:
//                          { rotate?: true }             troca por um novo par;
//                          { register_with_meta?: true } registra a pública na Meta (equivale a colar no WhatsApp Manager; só canal Meta).
// A visibilidade do canal segue a RLS do usuário (equipe); a gravação é do servidor (service role).
// ============================================================
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { logAuditEvent } from "@/lib/audit/log-event";
import { flowsKeyEvent } from "@/lib/audit/security-events";
import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { decryptStoredSecret } from "@/lib/whatsapp/encryption";
import { fetchChannelConfig } from "@/lib/whatsapp/channel-config";
import { ensureFlowsKeys, FlowsKeysUnavailableError, getFlowsKeyInfo } from "@/lib/whatsapp/flows-keys";
import { MetaApiError, setBusinessEncryptionKey } from "@/lib/whatsapp/meta-api";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ channelId: string }> };

const notFound = () => NextResponse.json({ error: "Canal não encontrado" }, { status: 404, headers: NO_STORE });
const unavailable = () => NextResponse.json({ error: "Chaves dos WhatsApp Flows indisponíveis: aplique a migration 291" }, { status: 503, headers: NO_STORE });

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requirePermission("channels.view");
    const { channelId } = await params;
    if (!UUID_RE.test(channelId)) return notFound();
    const visible = await ctx.supabase.from("whatsapp_config").select("id").eq("id", channelId).limit(1);
    if (visible.error || !visible.data?.length) return notFound();
    return NextResponse.json(await getFlowsKeyInfo(supabaseAdmin(), ctx.accountId, channelId), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof FlowsKeysUnavailableError) return unavailable();
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requirePermission("channels.manage");
    const { channelId } = await params;
    if (!UUID_RE.test(channelId)) return notFound();
    const limit = await checkRateLimit(`admin:flows-keys:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => ({}))) as { rotate?: unknown; register_with_meta?: unknown } | null;
    const rotate = body?.rotate === true;
    const register = body?.register_with_meta === true;

    const channel = await fetchChannelConfig<{ id: string; provider: string | null; phone_number_id: string | null; access_token: string | null }>(
      ctx.supabase,
      ctx.accountId,
      (q) => q.eq("id", channelId),
      "id, provider, phone_number_id, access_token",
    );
    if (channel.error || !channel.data) return notFound();
    if (register && (channel.data.provider === "waha" || !channel.data.phone_number_id || !channel.data.access_token)) {
      return NextResponse.json({ error: "Só canais Meta com número e token configurados podem registrar a chave" }, { status: 422, headers: NO_STORE });
    }

    const keys = await ensureFlowsKeys(supabaseAdmin(), ctx.accountId, channelId, { rotate });
    if (keys.created || rotate) void logAuditEvent(flowsKeyEvent({ accountId: ctx.accountId, channelId, action: rotate && !keys.created ? "rotated" : "created" }));

    let registeredWithMeta = false;
    if (register) {
      try {
        await setBusinessEncryptionKey({
          phoneNumberId: channel.data.phone_number_id!,
          accessToken: decryptStoredSecret(channel.data.access_token!, "whatsapp_config.access_token"),
          publicKeyPem: keys.public_key!,
        });
        registeredWithMeta = true;
      } catch (err) {
        if (err instanceof MetaApiError) {
          return NextResponse.json({ error: `A Meta recusou a chave: ${err.message}`, public_key: keys.public_key }, { status: 502, headers: NO_STORE });
        }
        throw err;
      }
    }
    return NextResponse.json({ ...keys, registered_with_meta: registeredWithMeta }, { status: keys.created ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof FlowsKeysUnavailableError) return unavailable();
    return toErrorResponse(err);
  }
}
