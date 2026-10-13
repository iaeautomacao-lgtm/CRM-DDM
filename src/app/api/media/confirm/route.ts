import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { confirmUploadedMedia } from "@/lib/storage/media-confirm";
import { MEDIA_PURPOSES, isAccountMediaPath, isMediaPurpose } from "@/lib/storage/media-validation";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const CONFIRMS_PER_MINUTE = { limit: 80, windowMs: 60_000 };

// POST /api/media/confirm  { purpose, path }
//
// Depois do upload pela URL assinada, revalida o OBJETO gravado: pasta da conta do chamador, MIME e tamanho gravados no
// Storage dentro do teto do tipo e magic bytes coerentes. Fora disso o objeto é apagado e a resposta é 422. Se passar,
// devolve a referência a gravar (`/api/chat-media/...` para chat-media; URL pública para flow-media).
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { purpose?: unknown; path?: unknown } | null;
    if (!body || !isMediaPurpose(body.purpose) || typeof body.path !== "string") {
      return NextResponse.json({ error: "Informe a origem e o caminho do arquivo.", code: "invalid" }, { status: 400, headers: NO_STORE });
    }
    const purpose = MEDIA_PURPOSES[body.purpose];
    const ctx = await requirePermission(purpose.permission);

    const limit = await checkRateLimit(`media:confirm:${ctx.userId}`, CONFIRMS_PER_MINUTE);
    if (!limit.success) return rateLimitResponse(limit);

    // Só objetos da pasta da PRÓPRIA conta: um caminho de outra conta é tratado como inexistente.
    if (!isAccountMediaPath(body.path, ctx.accountId)) {
      return NextResponse.json({ error: "Arquivo não encontrado.", code: "not_found" }, { status: 404, headers: NO_STORE });
    }

    const result = await confirmUploadedMedia(purpose.bucket, body.path);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, path: body.path, url: result.url, mime_type: result.mime, kind: result.kind }, { headers: NO_STORE });
  } catch (err) {
    return toErrorResponse(err);
  }
}
