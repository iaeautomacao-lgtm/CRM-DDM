import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { deleteStagedMedia } from "@/lib/storage/media-confirm";
import { MEDIA_PURPOSES, isAccountMediaPath, isMediaPurpose } from "@/lib/storage/media-validation";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const DELETES_PER_MINUTE = { limit: 80, windowMs: 60_000 };

// POST /api/media/delete  { purpose, path }
//
// Descarta um anexo em RASCUNHO (enviado e ainda não usado: rascunho cancelado, envio que falhou). O navegador não escreve nem
// apaga mais direto no Storage (migration 351 remove as policies de escrita). Só vale para objeto da pasta da PRÓPRIA conta criado
// há pouco; mídia antiga pode já estar numa mensagem enviada, num template ou num fluxo, e responde 409.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { purpose?: unknown; path?: unknown } | null;
    if (!body || !isMediaPurpose(body.purpose) || typeof body.path !== "string") {
      return NextResponse.json({ error: "Informe a origem e o caminho do arquivo.", code: "invalid" }, { status: 400, headers: NO_STORE });
    }
    const purpose = MEDIA_PURPOSES[body.purpose];
    const ctx = await requirePermission(purpose.permission);

    const limit = await checkRateLimit(`media:delete:${ctx.userId}`, DELETES_PER_MINUTE);
    if (!limit.success) return rateLimitResponse(limit);

    if (!isAccountMediaPath(body.path, ctx.accountId)) {
      return NextResponse.json({ error: "Arquivo não encontrado.", code: "not_found" }, { status: 404, headers: NO_STORE });
    }
    const result = await deleteStagedMedia(purpose.bucket, body.path);
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return toErrorResponse(err);
  }
}
