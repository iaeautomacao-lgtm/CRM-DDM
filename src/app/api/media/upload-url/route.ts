import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { buildServerMediaPath, createUploadTarget } from "@/lib/storage/media-confirm";
import { MEDIA_PURPOSES, checkUploadRequest, isMediaPurpose } from "@/lib/storage/media-validation";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** Uploads por usuário por minuto (uma ráfaga de anexos é normal; script em laço, não). */
const UPLOADS_PER_MINUTE = { limit: 40, windowMs: 60_000 };

// POST /api/media/upload-url  { purpose, name, mime_type, size }
//
// Autoriza o envio de UM arquivo ao Storage (chat-media / flow-media): valida a permissão da origem, o tipo e o tamanho por
// tipo e devolve uma URL assinada de upload num caminho DENTRO da pasta da conta do chamador. O navegador sobe o arquivo
// com `uploadToSignedUrl` e depois chama POST /api/media/confirm, que revalida o objeto gravado (a URL assinada não impõe
// tipo nem tamanho). O navegador não escreve mais no bucket com a própria sessão.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { purpose?: unknown; name?: unknown; mime_type?: unknown; size?: unknown } | null;
    if (!body || !isMediaPurpose(body.purpose)) {
      return NextResponse.json({ error: "Informe a origem do arquivo.", code: "invalid" }, { status: 400, headers: NO_STORE });
    }
    const purpose = MEDIA_PURPOSES[body.purpose];
    const ctx = await requirePermission(purpose.permission);

    const limit = await checkRateLimit(`media:upload:${ctx.userId}`, UPLOADS_PER_MINUTE);
    if (!limit.success) return rateLimitResponse(limit);

    const checked = checkUploadRequest({ mime: body.mime_type, size: body.size });
    if (!checked.ok) return NextResponse.json({ error: checked.error, code: "invalid" }, { status: 400, headers: NO_STORE });

    const name = typeof body.name === "string" && body.name ? body.name : "arquivo";
    const target = await createUploadTarget(purpose.bucket, buildServerMediaPath(ctx.accountId, name));
    if (!target) {
      return NextResponse.json({ error: "Não foi possível enviar o arquivo agora.", code: "unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json(
      { bucket: purpose.bucket, path: target.path, upload_token: target.token, mime_type: checked.mime },
      { headers: NO_STORE },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
